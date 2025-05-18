from typing import Any, Dict

from fastapi import Depends

from backend.app.services.modification_tools.edit_file_service import (
    EditFileService,
)


class EditFileUsecase:
    def __init__(self, edit_file_service: EditFileService = Depends()):
        self.edit_file_service = edit_file_service

    async def execute(
        self, target_file_path: str, code_snippet: str, explanation: str
    ) -> Dict[str, Any]:

        return await self.edit_file_service.edit_file(
            target_file_path, code_snippet, explanation
        )
