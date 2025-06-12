from typing import Any, Dict

from fastapi import Depends

from system.backend.app.models.domain.error import Error
from system.backend.app.models.schemas.grep_search_query_schema import (
    GrepSearchQueryRequest,
)
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.terminal_client_service import (
    TerminalClientService,
)


class GrepSearchUsecase:
    def __init__(
        self,
        error_repo: ErrorRepo = Depends(ErrorRepo),
        terminal_client: TerminalClientService = Depends(),
    ):
        self.error_repo = error_repo
        self.terminal_client = terminal_client

    async def execute_grep_search(
        self, request: GrepSearchQueryRequest, workspace_path: str = None
    ) -> Dict[str, Any]:
        """
        Execute a grep search using ripgrep through the client-side terminal API.

        Args:
            request: The grep search request containing query parameters
            workspace_path: The workspace path

        Returns:
            A dictionary with the search results and metadata
        """
        query = request.query
        case_sensitive = request.case_sensitive
        include_pattern = request.include_pattern
        exclude_pattern = request.exclude_pattern

        try:
            # Build the ripgrep command
            cmd_parts = ["rg", "--no-heading", "--line-number", "--color=never"]

            if not case_sensitive:
                cmd_parts.append("-i")

            # Only add include/exclude patterns if they are meaningful
            if include_pattern and include_pattern.strip():
                cmd_parts.extend(["-g", f'"{include_pattern}"'])

            if exclude_pattern and exclude_pattern.strip():
                cmd_parts.extend(["-g", f'!"/{exclude_pattern}/"'])

            # Add the search query (properly escaped)
            cmd_parts.append(f'"{query}"')
            cmd_parts.append(".")

            # Join command parts into a single command string
            command = " ".join(cmd_parts)

            # Execute the command using the terminal client (silently)
            result = await self.terminal_client.execute_terminal_command(
                command=command,
                workspace_path=workspace_path,
                timeout=60,  # 60 second timeout
                silent=True,  # Don't show this command in terminal
            )

            # Check if command executed successfully
            exit_code = result.get("exitCode", 0)
            if exit_code not in [
                0,
                1,
            ]:  # 0 = found, 1 = not found, others = error
                error_msg = result.get("error", "Unknown error")
                return {
                    "results": f"Error executing search: {error_msg}",
                    "count": 0,
                    "status": "error",
                }

            output = result.get("output", "")
            output_lines = output.strip().split("\n") if output.strip() else []

            # Process the output (limit to max 50 matches)
            matches = []
            match_count = 0

            for line in output_lines:
                if line.strip() and match_count < 50:
                    matches.append(line.strip())
                    match_count += 1

            return {
                "results": (
                    "\n".join(matches) if matches else "No matches found"
                ),
                "currentDirectory": result.get("currentDirectory", "Not Found"),
                "count": str(match_count),
                "status": "success",
            }
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="grep_search",
                    error_message=f"Error executing search: {str(e)}",
                )
            )
            return {
                "results": f"Error executing search: {str(e)}",
                "count": 0,
                "status": "error",
            }
