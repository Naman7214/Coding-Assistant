import os
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.terminal_client_service import (
    TerminalClientService,
)


class FileSearchService:
    def __init__(
        self,
        error_repo: ErrorRepo = Depends(),
        terminal_client: TerminalClientService = Depends(),
    ):
        self.error_repo = error_repo
        self.terminal_client = terminal_client

    async def search_files(
        self,
        pattern: str,
        workspace_path: Optional[str] = None,
        explanation: str = "",
    ) -> Dict[str, Any]:
        """
        Search for files using fzf for fuzzy file matching.

        Args:
            pattern: Search pattern for file names
            workspace_path: Base directory to search in
            explanation: Explanation for the operation

        Returns:
            Dictionary with search results and current directory
        """
        try:
            workspace_path = workspace_path or "/"

            current_dir_result = (
                await self.terminal_client.execute_terminal_command(
                    command="pwd", workspace_path=workspace_path, silent=True
                )
            )
            current_directory = current_dir_result.get("output", "").strip()

            # Build fzf search command (non-interactive)
            search_cmd = self._build_fzf_file_search_command(
                workspace_path, pattern
            )

            # Execute fzf search command silently (no terminal window)
            search_result = await self.terminal_client.execute_terminal_command(
                command=search_cmd, workspace_path=workspace_path, silent=True
            )

            if search_result.get("exitCode", 1) != 0:
                # No results found or error
                return {
                    "files": [],
                    "total_files": 0,
                    "pattern": pattern,
                    "base_path": workspace_path,
                    "currentDirectory": current_directory,
                }

            # Parse found files
            output = search_result.get("output", "").strip()
            found_files = []

            if output:
                lines = output.split("\n")
                for line in lines[:10]:  # Limit to top 10 matches
                    if line.strip():
                        file_path = line.strip()
                        if os.path.isfile(file_path):
                            found_files.append(file_path)

            return {
                "files": found_files,
                "total_files": len(found_files),
                "pattern": pattern,
                "base_path": workspace_path,
                "current_directory": current_directory,
            }

        except HTTPException:
            raise
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="file_search",
                    error_message=f"Error searching files: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )

            # Get current directory even on error
            try:
                current_dir_result = (
                    await self.terminal_client.execute_terminal_command(
                        command="pwd",
                        workspace_path=workspace_path or "/",
                        silent=True,
                    )
                )
                current_directory = current_dir_result.get("output", "").strip()
            except:
                current_directory = workspace_path or "/"

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Internal error: {str(e)}",
            )

    def _build_fzf_file_search_command(
        self, workspace_path: str, pattern: str
    ) -> str:
        """Build non-interactive fzf command for file search."""

        # Escape pattern for shell safety
        escaped_pattern = pattern.replace("'", "'\"'\"'")

        # Define excluded directories
        excluded_dirs = [
            "node_modules",
            ".git",
            ".vscode",
            ".idea",
            "__pycache__",
            "venv",
            ".venv",
            "env",
            ".env",
            "dist",
            "build",
            ".next",
            ".DS_Store",
            "coverage",
            ".nyc_output",
        ]

        # Build exclusion filters for find
        exclude_options = ""
        for exclude in excluded_dirs:
            exclude_options += (
                f" -not -path '*/{exclude}/*' -not -name '{exclude}'"
            )

        # Create non-interactive fzf command using echo to simulate input
        # This makes fzf work in non-interactive mode by providing the pattern as input
        fzf_cmd = f"""
find "{workspace_path}" -type f{exclude_options} 2>/dev/null | \\
fzf --filter='{escaped_pattern}' --no-sort | \\
head -10
""".strip()

        return fzf_cmd
