import os
from datetime import datetime
from typing import Optional

from fastapi import Depends, HTTPException, status

from src.app.models.domain.error import Error
from src.app.repositories.error_repo import ErrorRepo


class FileReadService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo

    async def read_file(
        self,
        file_path: str,
        start_line: Optional[int],
        end_line: Optional[int],
        explanation: str,
    ):
        try:
            stats = os.stat(file_path)

            with open(file_path, "r", encoding="utf-8") as file:
                lines = file.readlines()

                if start_line is not None or end_line is not None:
                    start = start_line if start_line is not None else 0
                    end = end_line if end_line is not None else len(lines)
                    lines = lines[start:end]

                content = "".join(lines)

            return {
                "content": content,
                "size_bytes": stats.st_size,
                "last_modified": datetime.fromtimestamp(
                    stats.st_mtime
                ).isoformat(),
            }

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="FileReadService",
                    error_message=f"Error reading file {file_path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error reading file {file_path}: {str(e)}",
            )
