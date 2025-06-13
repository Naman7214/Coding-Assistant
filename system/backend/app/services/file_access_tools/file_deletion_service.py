import os
from datetime import datetime
from typing import Any, Dict

from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.terminal_client_service import (
    TerminalClientService,
)


class FileDeletionService:
    def __init__(
        self,
        error_repo: ErrorRepo = Depends(),
        terminal_client: TerminalClientService = Depends(),
    ):
        self.error_repo = error_repo
        self.terminal_client = terminal_client
        self.PROTECTED_PATHS = {
            "node_modules",
            "package.json",
            "package-lock.json",
            "yarn.lock",
            "tsconfig.json",
            "next.config.js",
            ".git",
            ".env",
            ".env.local",
            ".env.development",
            ".env.production",
            "public",
            "build",
            "dist",
            ".next",
            "README.md",
            "venv",
            ".venv",
        }

    async def delete_file(
        self, path: str, explanation: str, workspace_path: str = None
    ) -> Dict[str, Any]:
        """
        Delete a file or directory with safety checks using client-side API.

        Args:
            path: Path to the file or directory to delete
            explanation: Explanation for why the deletion is needed
            workspace_path: The workspace path

        Returns:
            A dictionary with the deletion status and any error
        """

        try:
            # Normalize the path to handle relative paths properly
            if not os.path.isabs(path):
                # If it's a relative path, make it relative to workspace
                path = os.path.join(workspace_path or ".", path)

            # Check if the path is protected
            file_name = os.path.basename(path)
            if file_name in self.PROTECTED_PATHS:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Cannot delete protected file/directory: {file_name}",
                )

            # Check if file/directory exists using ls command for better cross-platform compatibility
            check_result = await self.terminal_client.execute_terminal_command(
                command=self._get_file_check_command(path),
                workspace_path=workspace_path,
                silent=True,
            )

            if check_result.get("exitCode", 1) != 0:
                return {
                    "success": False,
                    "message": f"File or directory not found: {path}",
                    "deleted": False,
                }

            # Check if it's a directory
            is_dir_result = await self.terminal_client.execute_terminal_command(
                command=self._get_is_directory_command(path),
                workspace_path=workspace_path,
                silent=True,
            )

            is_directory = is_dir_result.get("exitCode", 1) == 0

            # Choose appropriate delete command
            if is_directory:
                delete_cmd = self._get_delete_directory_command(path)
            else:
                delete_cmd = self._get_delete_file_command(path)

            # Execute delete command
            delete_result = await self.terminal_client.execute_terminal_command(
                command=delete_cmd, workspace_path=workspace_path, silent=True
            )

            if delete_result.get("exitCode", 1) != 0:
                error_msg = delete_result.get(
                    "error", "Unknown error during deletion"
                )
                return {
                    "success": False,
                    "current_directory": delete_result.get(
                        "currentDirectory", "Not Found"
                    ),
                    "message": f"Failed to delete {path}: {error_msg}",
                    "deleted": False,
                }

            return {
                "success": True,
                "message": f"Successfully deleted {'directory' if is_directory else 'file'}: {path}",
                "deleted": True,
                "type": "directory" if is_directory else "file",
            }

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="file_deletion",
                    error_message=f"Error deleting {path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            return {
                "success": False,
                "message": f"Error deleting {path}: {str(e)}",
                "deleted": False,
            }

    def _get_file_check_command(self, path: str) -> str:
        """Get command to check if file exists (cross-platform)."""
        # Use ls command which works on both Unix and Windows (with Git Bash/WSL)
        return f'ls "{path}" >/dev/null 2>&1'

    def _get_file_info_command(self, path: str) -> str:
        """Get command to get file information."""
        return f'ls -la "{path}"'

    def _get_is_directory_command(self, path: str) -> str:
        """Get command to check if path is a directory (cross-platform)."""
        return f'test -d "{path}"'

    def _get_delete_file_command(self, path: str) -> str:
        """Get command to delete a file (cross-platform)."""
        # Escape the path properly to handle spaces and special characters
        escaped_path = path.replace('"', '\\"')
        return f'rm "{escaped_path}"'

    def _get_delete_directory_command(self, path: str) -> str:
        """Get command to delete a directory (cross-platform)."""
        # Escape the path properly to handle spaces and special characters
        escaped_path = path.replace('"', '\\"')
        return f'rm -rf "{escaped_path}"'
