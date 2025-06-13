import asyncio
import glob
import os
import re
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.terminal_client_service import (
    TerminalClientService,
)
from system.backend.app.utils.path_validator import is_safe_path


class SearchReplaceService:
    def __init__(
        self,
        error_repo: ErrorRepo = Depends(),
        terminal_client: TerminalClientService = Depends(),
    ):
        self.error_repo = error_repo
        self.terminal_client = terminal_client

    async def search_and_replace(
        self,
        query: str,
        replacement: str,
        explanation: str,
        options: Optional[Dict[str, Any]] = None,
        workspace_path: str = None,
    ) -> Dict[str, Any]:
        """
        Search for text and replace it in files.

        Args:
            query: The text or regex pattern to search for
            replacement: The text to replace the matched content with
            options: Dictionary containing search options
            explanation: Explanation for the operation

        Returns:
            Dictionary with results of the operation
        """

        if options is None:
            options = {
                "search_paths": [workspace_path],
            }

        case_sensitive = options.get("case_sensitive", True)
        include_pattern = options.get("include_pattern", "*")
        exclude_pattern = options.get("exclude_pattern", "")
        search_paths = options.get("search_paths", ".")

        if search_paths:
            search_paths = [os.path.abspath(path) for path in search_paths]
        else:
            search_paths = [workspace_path]

        safe_search_paths = []
        for path in search_paths:
            is_safe, error_msg = is_safe_path(path)
            if not is_safe:
                await self.error_repo.insert_error(
                    Error(
                        tool_name="SearchReplaceService",
                        error_message=f"Access denied: {error_msg}",
                        timestamp=datetime.now().isoformat(),
                    )
                )
            else:
                safe_search_paths.append(path)

        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            pattern = re.compile(query, flags)
        except re.error as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Invalid regex pattern: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            return {
                "success": False,
                "error": f"Invalid regex pattern: {str(e)}",
                "files_affected": 0,
                "matches": 0,
            }

        results = {
            "success": True,
            "files_affected": 0,
            "matches": 0,
            "changes": [],
        }

        try:
            # Process paths concurrently
            tasks = []
            for path in safe_search_paths:
                task = self._process_path(
                    path,
                    pattern,
                    replacement,
                    include_pattern,
                    exclude_pattern,
                    results,
                )
                tasks.append(task)

            await asyncio.gather(*tasks)

            return results

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Error in search and replace: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error in search and replace: {str(e)}",
            )

    async def _process_path(
        self,
        path: str,
        pattern: re.Pattern,
        replacement: str,
        include_pattern: str,
        exclude_pattern: str,
        results: Dict[str, Any],
    ) -> None:
        """Process a single search path asynchronously using terminal commands."""

        # Define directories to always exclude
        excluded_dirs = {
            ".git",
            ".venv",
            "venv",
            ".env",
            "env",
            "node_modules",
            "__pycache__",
            ".next",
            "dist",
            "build",
            ".DS_Store",
            ".vscode",
            ".idea",
            "coverage",
            ".nyc_output",
        }

        # Check if path is a directory using terminal
        is_dir_result = await self.terminal_client.execute_terminal_command(
            command=f'test -d "{path}"',
            workspace_path=os.path.dirname(path) or "/",
            silent=True,
        )

        is_directory = is_dir_result.get("exitCode", 1) == 0

        if is_directory:
            # Use find command to get files matching include patterns
            include_paths = await self._find_files_with_pattern(
                path, include_pattern, excluded_dirs
            )

            if exclude_pattern:
                # Get files to exclude and remove them from include_paths
                exclude_paths = await self._find_files_with_pattern(
                    path, exclude_pattern, excluded_dirs
                )
                exclude_set = set(exclude_paths)
                include_paths = [
                    p for p in include_paths if p not in exclude_set
                ]
        else:
            # Single file case
            include_paths = (
                [path] if self._matches_pattern(path, include_pattern) else []
            )
            if exclude_pattern and self._matches_pattern(path, exclude_pattern):
                include_paths = []

        file_tasks = []
        for file_path in include_paths:
            # Check if it's a file using terminal
            is_file_result = (
                await self.terminal_client.execute_terminal_command(
                    command=f'test -f "{file_path}"',
                    workspace_path=os.path.dirname(file_path) or "/",
                    silent=True,
                )
            )

            if is_file_result.get("exitCode", 1) == 0:
                # Additional check to ensure we don't process files in excluded directories
                file_dir_parts = os.path.normpath(file_path).split(os.sep)
                if not any(part in excluded_dirs for part in file_dir_parts):
                    task = self._process_file(
                        file_path, pattern, replacement, results
                    )
                    file_tasks.append(task)

        await asyncio.gather(*file_tasks)

    async def _find_files_with_pattern(
        self, search_path: str, pattern: str, excluded_dirs: set
    ) -> list:
        """Find files matching pattern using terminal find command."""
        try:
            all_files = []

            # Build exclusion options for find command
            exclude_options = ""
            for exclude_dir in excluded_dirs:
                exclude_options += f" -not -path '*/{exclude_dir}/*'"

            # Process each pattern (comma-separated)
            for single_pattern in pattern.split(","):
                single_pattern = single_pattern.strip()
                if not single_pattern:
                    continue

                # Use find command to search for files matching the pattern
                find_cmd = f'find "{search_path}" -type f -name "{single_pattern}"{exclude_options} 2>/dev/null'

                result = await self.terminal_client.execute_terminal_command(
                    command=find_cmd,
                    workspace_path=search_path,
                    silent=True,
                )

                if result.get("exitCode", 1) == 0:
                    output = result.get("output", "").strip()
                    if output:
                        files = [
                            line.strip()
                            for line in output.split("\n")
                            if line.strip()
                        ]
                        all_files.extend(files)

            return list(set(all_files))  # Remove duplicates

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Error finding files with pattern {pattern}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            return []

    def _matches_pattern(self, path: str, pattern: str) -> bool:
        """Check if a path matches a glob pattern."""
        for single_pattern in pattern.split(","):
            single_pattern = single_pattern.strip()
            if glob.fnmatch.fnmatch(os.path.basename(path), single_pattern):
                return True
        return False

    async def _process_file(
        self,
        file_path: str,
        pattern: re.Pattern,
        replacement: str,
        results: Dict[str, Any],
    ) -> None:
        """Process a single file for search and replace asynchronously using terminal commands."""
        try:
            # Read file content using terminal cat command
            read_result = await self.terminal_client.execute_terminal_command(
                command=f'cat "{file_path}"',
                workspace_path=os.path.dirname(file_path) or "/",
                silent=True,
            )

            if read_result.get("exitCode", 1) != 0:
                # Skip file if can't be read
                return

            original_content = read_result.get("output", "")

            matches = list(pattern.finditer(original_content))
            if not matches:
                return

            new_content = pattern.sub(replacement, original_content)
            file_changes = []

            for match in matches:
                start, end = match.span()
                before_ctx = original_content[max(0, start - 50) : start]
                matched_text = original_content[start:end]
                after_ctx = original_content[
                    end : min(len(original_content), end + 50)
                ]

                replaced_text = pattern.sub(replacement, matched_text)

                file_changes.append(
                    {
                        "line_number": original_content[:start].count("\n") + 1,
                        "context": f"{before_ctx}[{matched_text}]{after_ctx}",
                        "replacement": replaced_text,
                    }
                )

            # Write the new content using terminal commands
            await self._write_file_content(file_path, new_content)

            # Update results with a lock to avoid race conditions
            async with asyncio.Lock():
                results["files_affected"] += 1
                results["matches"] += len(matches)
                results["changes"].append(
                    {
                        "file": file_path,
                        "matches": len(matches),
                        "changes": file_changes,
                    }
                )

        except Exception as e:
            async with asyncio.Lock():
                results["success"] = False
                results["error"] = (
                    f"Error processing file {file_path}: {str(e)}"
                )

            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Error processing file {file_path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )

    async def _write_file_content(self, file_path: str, content: str) -> None:
        """Write content to a file using terminal commands."""
        try:
            # Use the terminal client's write_file method if available
            try:
                await self.terminal_client.write_file(
                    file_path=file_path,
                    content=content,
                    workspace_path=os.path.dirname(file_path) or "/",
                )
                return
            except Exception:
                # Fallback to terminal commands if write_file method fails
                pass

            # For safety, use base64 encoding to handle special characters
            import base64

            encoded_content = base64.b64encode(content.encode("utf-8")).decode(
                "ascii"
            )

            # Use base64 decoding to write the file safely
            write_cmd = f'echo "{encoded_content}" | base64 -d > "{file_path}"'

            write_result = await self.terminal_client.execute_terminal_command(
                command=write_cmd,
                workspace_path=os.path.dirname(file_path) or "/",
                silent=True,
            )

            if write_result.get("exitCode", 1) != 0:

                escaped_content = content.replace(
                    "'", "'\"'\"'"
                )  # Escape single quotes
                cat_cmd = (
                    f"cat > \"{file_path}\" << 'EOF'\n{escaped_content}\nEOF"
                )

                fallback_result = (
                    await self.terminal_client.execute_terminal_command(
                        command=cat_cmd,
                        workspace_path=os.path.dirname(file_path) or "/",
                        silent=True,
                    )
                )

                if fallback_result.get("exitCode", 1) != 0:
                    raise Exception(
                        f"Failed to write file: {write_result.get('error', 'Unknown error')}"
                    )

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Error writing file {file_path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise
