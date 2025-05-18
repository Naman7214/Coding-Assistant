import json
import subprocess
from typing import Any, Dict

from fastapi import Depends

from backend.app.models.domain.error import Error
from backend.app.models.schemas.grep_search_query_schema import (
    GrepSearchQueryRequest,
)
from backend.app.repositories.error_repo import ErrorRepo


class GrepSearchUsecase:
    def __init__(self, error_repo: ErrorRepo = Depends(ErrorRepo)):
        self.error_repo = error_repo

    async def execute_grep_search(
        self, request: GrepSearchQueryRequest
    ) -> Dict[str, Any]:
        """
        Execute a grep search using ripgrep.

        Args:
            query: The regex pattern to search for
            case_sensitive: Whether the search should be case sensitive
            include_pattern: Glob pattern for files to include
            exclude_pattern: Glob pattern for files to exclude
            explanation: Explanation for why the search is being performed

        Returns:
            A dictionary with the search results and metadata
        """
        query = request.query
        case_sensitive = request.case_sensitive
        include_pattern = request.include_pattern
        exclude_pattern = request.exclude_pattern

        # Build the ripgrep command
        cmd = ["rg", "--json"]

        if not case_sensitive:
            cmd.append("-i")

        # Only add include/exclude patterns if they are meaningful
        if include_pattern:
            cmd.extend(["-g", include_pattern])

        if exclude_pattern:
            cmd.extend(["-g", f"!{exclude_pattern}"])

            # Add the query and directory (codebase directory by default)
        cmd.extend([query, "codebase"])

        try:
            # Debug: Print the command being executed
            print(f"Executing command: {' '.join(cmd)}")

            # Execute the command and capture output
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30
            )
            output_lines = result.stdout.strip().split("\n")

            # Process the output (limit to max 50 matches)
            matches = []
            match_count = 0

            for line in output_lines:
                if not line:
                    continue

                try:
                    match_data = json.loads(line)
                    if "data" in match_data and match_data["type"] == "match":
                        file_path = (
                            match_data["data"].get("path", {}).get("text", "")
                        )
                        line_number = match_data["data"].get("line_number", 0)
                        match_content = (
                            match_data["data"]
                            .get("lines", {})
                            .get("text", "")
                            .strip()
                        )

                        matches.append(
                            f"{file_path}:{line_number}: {match_content}"
                        )
                        match_count += 1

                        if match_count >= 50:
                            matches.append(
                                "... (output truncated at 50 matches)"
                            )
                            break
                except json.JSONDecodeError:
                    continue

            ans = {
                "results": (
                    "\n".join(matches) if matches else "No matches found"
                ),
                "count": str(match_count),
                "status": "success",
            }
            print(f"{ans}")
            return {
                "results": (
                    "\n".join(matches) if matches else "No matches found"
                ),
                "count": str(match_count),
                "status": "success",
            }

        except subprocess.TimeoutExpired:
            return {
                "results": "Search timed out after 30 seconds",
                "count": 0,
                "status": "timeout",
            }
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="grep_search",
                    error_message=f"Error executing search: {str(e)}",
                )
            )
            error = {
                "results": f"Error executing search: {str(e)}",
                "count": 0,
                "status": "error",
            }
            print(f"error: {error}")
            return {
                "results": f"Error executing search: {str(e)}",
                "count": 0,
                "status": "error",
            }
