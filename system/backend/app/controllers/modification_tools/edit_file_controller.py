from fastapi import Depends, status
from fastapi.responses import JSONResponse

from system.backend.app.models.schemas.modification_schemas import (
    EditFileRequest,
)
from system.backend.app.usecases.modification_tools.edit_file_usecase import (
    EditFileUsecase,
)


class EditFileController:
    def __init__(
        self, edit_file_usecase: EditFileUsecase = Depends(EditFileUsecase)
    ):
        self.edit_file_usecase = edit_file_usecase

    async def execute(self, request: EditFileRequest):
        response = await self.edit_file_usecase.execute(
            request.target_file_path, request.code_snippet, request.explanation
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
