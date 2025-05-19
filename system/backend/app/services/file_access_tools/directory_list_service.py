import os
from datetime import datetime
from typing import Any, Dict, List

from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.utils.path_validator import is_safe_path


class DirectoryListService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo

    async def list_directory(
        self,
        dir_path: str,
        recursive: bool,
        explanation: str,
    ) -> List[Dict[str, Any]]:
        try:
            # Ensure dir_path is not empty or just whitespace
            dir_path = dir_path.strip()

            if len(dir_path) == 0:
                dir_path = os.path.abspath("codebase")

            # Check if path is safe
            is_safe, error_msg = is_safe_path(dir_path)
            if not is_safe:
                await self.error_repo.insert_error(
                    Error(
                        tool_name="DirectoryListService",
                        error_message=f"Access denied: {error_msg}",
                        timestamp=datetime.now().isoformat(),
                    )
                )
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Access denied: {error_msg}",
                )

            # Verify that the directory exists
            if not os.path.exists(dir_path):
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Directory not found: {dir_path}",
                )

            if not os.path.isdir(dir_path):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Path is not a directory: {dir_path}",
                )

            # Directories to exclude from listing
            excluded_dirs = [
                "node_modules",
                "venv",
                ".venv",
                "env",
                ".env",
                "__pycache__",
            ]

            async def process_directory(
                current_path: str,
            ) -> List[Dict[str, Any]]:
                items = []

                try:
                    for item in os.listdir(current_path):
                        # Skip hidden files and excluded directories
                        if item.startswith(".") or item in excluded_dirs:
                            continue

                        full_path = os.path.join(current_path, item)

                        if os.path.isdir(full_path):
                            items.append(
                                {
                                    "path": full_path,
                                    "type": "directory",
                                    "size_bytes": None,
                                    "last_modified": None,
                                }
                            )

                            if recursive:
                                items.extend(await process_directory(full_path))

                        else:
                            stats = os.stat(full_path)
                            items.append(
                                {
                                    "path": full_path,
                                    "type": "file",
                                    "size_bytes": stats.st_size,
                                    "last_modified": datetime.fromtimestamp(
                                        stats.st_mtime
                                    ).isoformat(),
                                }
                            )

                except PermissionError:

                    await self.error_repo.insert_error(
                        Error(
                            tool_name="DirectoryListService",
                            error_message=f"Permission denied for directory: {current_path}",
                            timestamp=datetime.now().isoformat(),
                        )
                    )
                    return [
                        {
                            "path": current_path,
                            "type": "directory",
                            "size_bytes": 0,
                            "last_modified": datetime.now().isoformat(),
                            "error": "Permission denied",
                        }
                    ]

                return items

            return await process_directory(dir_path)

        except HTTPException:
            # Re-raise HTTP exceptions to preserve their status codes
            raise
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="DirectoryListService",
                    error_message=f"Error listing directory {dir_path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error listing directory {dir_path}: {str(e)}",
            )
