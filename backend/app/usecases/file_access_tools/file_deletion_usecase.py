from typing import Any, Dict, Optional

from fastapi import Depends

from backend.app.services.file_access_tools.file_deletion_service import (
    FileDeletionService,
)


class FileDeletionUseCase:
    def __init__(self, file_deletion_service: FileDeletionService = Depends()):
        self.file_deletion_service = file_deletion_service

    async def execute(
        self, path: str, explanation: Optional[str]
    ) -> Dict[str, Any]:

        return await self.file_deletion_service.delete_file(path, explanation)
