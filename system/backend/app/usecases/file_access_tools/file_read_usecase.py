from typing import Any, Dict, Optional

from fastapi import Depends

from system.backend.app.services.file_access_tools.file_read_service import (
    FileReadService,
)


class FileReadUseCase:
    def __init__(self, file_read_service: FileReadService = Depends()):
        self.file_read_service = file_read_service

    async def execute(
        self,
        file_path: str,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None,
        explanation: Optional[str] = None,
        workspace_path: str = None,
    ) -> Dict[str, Any]:

        return await self.file_read_service.read_file(
            file_path=file_path,
            explanation=explanation or "Reading file",
            workspace_path=workspace_path,
            start_line=start_line,
            end_line=end_line,
        )
