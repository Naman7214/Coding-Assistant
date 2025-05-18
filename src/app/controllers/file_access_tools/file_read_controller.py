from fastapi import Depends, status
from fastapi.responses import JSONResponse

from src.app.models.schemas.file_access_schemas import FileReadRequest
from src.app.usecases.file_access_tools.file_read_usecase import FileReadUseCase


class FileReadController:
    def __init__(self, file_read_usecase: FileReadUseCase = Depends()):
        self.file_read_usecase = file_read_usecase

    async def execute(self, request: FileReadRequest):
        response = await self.file_read_usecase.execute(
            request.file_path,
            request.start_line,
            request.end_line,
            request.explanation,
        )

        return JSONResponse(
            content={
                "data": response,
                "message": "File read successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
