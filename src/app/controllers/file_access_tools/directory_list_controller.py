from fastapi import Depends, status
from fastapi.responses import JSONResponse

from src.app.models.schemas.file_access_schemas import DirectoryListRequest
from src.app.usecases.file_access_tools.directory_list_usecase import (
    DirectoryListUseCase,
)


class DirectoryListController:
    def __init__(
        self, directory_list_usecase: DirectoryListUseCase = Depends()
    ):
        self.directory_list_usecase = directory_list_usecase

    async def execute(self, request: DirectoryListRequest):
        response = await self.directory_list_usecase.execute(
            request.dir_path, request.recursive, request.explanation
        )

        return JSONResponse(
            content={
                "data": response,
                "message": "Directory listed successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
