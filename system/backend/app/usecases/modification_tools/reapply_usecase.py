from typing import Any, Dict

from fastapi import Depends

from system.backend.app.services.modification_tools.reapply_service import (
    ReapplyService,
)


class ReapplyUsecase:
    def __init__(self, reapply_service: ReapplyService = Depends()):
        self.reapply_service = reapply_service

    async def execute(
        self,
        target_file_path: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ) -> Dict[str, Any]:

        return await self.reapply_service.reapply(
            target_file_path, code_snippet, explanation, workspace_path
        )
