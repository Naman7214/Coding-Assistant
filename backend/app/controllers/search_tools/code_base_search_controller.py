from fastapi import Depends, status
from fastapi.responses import JSONResponse

from backend.app.models.schemas.code_base_search_schema import (
    CodeBaseSearchQueryRequest,
)
from backend.app.usecases.search_tools.code_base_usecase import (
    CodeBaseSearchUsecase,
)


class CodeBaseSearchController:
    def __init__(
        self,
        code_base_search_usecase: CodeBaseSearchUsecase = Depends(
            CodeBaseSearchUsecase
        ),
    ):
        self.code_base_search_usecase = code_base_search_usecase

    async def process_query(self, request: CodeBaseSearchQueryRequest):
        result = await self.code_base_search_usecase.process_query(request)
        return JSONResponse(
            content={
                "data": result,
                "message": "Code base search completed successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
