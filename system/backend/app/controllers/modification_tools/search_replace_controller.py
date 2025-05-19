from fastapi import Depends, status
from fastapi.responses import JSONResponse

from system.backend.app.models.schemas.modification_schemas import SearchReplaceRequest
from system.backend.app.usecases.modification_tools.search_replace_usecase import (
    SearchReplaceUseCase,
)


class SearchReplaceController:
    def __init__(
        self, search_replace_usecase: SearchReplaceUseCase = Depends()
    ):
        self.search_replace_usecase = search_replace_usecase

    async def execute(self, request: SearchReplaceRequest):

        options = None
        if request.options:
            options = request.options.model_dump()

        response = await self.search_replace_usecase.execute(
            request.query, request.replacement, request.explanation, options
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
