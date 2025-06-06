from fastapi import Depends, status
from fastapi.responses import JSONResponse

from system.backend.app.models.schemas.modification_schemas import (
    ReapplyRequest,
)
from system.backend.app.usecases.modification_tools.reapply_usecase import (
    ReapplyUsecase,
)


class ReapplyController:
    def __init__(
        self, reapply_usecase: ReapplyUsecase = Depends(ReapplyUsecase)
    ):
        self.reapply_usecase = reapply_usecase

    async def execute(self, request: ReapplyRequest):
        response = await self.reapply_usecase.execute(
            request.target_file_path,
            request.code_snippet,
            request.explanation,
            request.workspace_path,
        )

        status_code = status.HTTP_200_OK
        if not response.get("success", True):
            status_code = status.HTTP_400_BAD_REQUEST

        message = "Search and replace completed successfully"
        if response.get("error"):
            message = response["error"]

        return JSONResponse(
            content={
                "data": response,
                "message": message,
                "error": response.get("error"),
            },
            status_code=status_code,
        )
