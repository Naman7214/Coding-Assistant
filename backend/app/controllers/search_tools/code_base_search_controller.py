from fastapi import Depends, status
from fastapi.responses import JSONResponse

from backend.app.models.schemas.code_base_search_schema import (
    CodeBaseSearchQueryRequest,
)
from backend.app.models.schemas.grep_search_query_schema import (
    GrepSearchQueryRequest,
)
from backend.app.usecases.search_tools.code_base_usecase import (
    CodeBaseSearchUsecase,
)
from backend.app.usecases.search_tools.grep_search_usecase import GrepSearchUsecase


class CodeBaseSearchController:
    def __init__(
        self,
        code_base_search_usecase: CodeBaseSearchUsecase = Depends(
            CodeBaseSearchUsecase
        ),
        grep_search_usecase: GrepSearchUsecase = Depends(GrepSearchUsecase),
    ):
        self.code_base_search_usecase = code_base_search_usecase
        self.grep_search_usecase = grep_search_usecase

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

    async def process_grep_query(self, request: GrepSearchQueryRequest):
        result = await self.grep_search_usecase.execute_grep_search(request)
        return JSONResponse(
            content={
                "data": result,
                "message": "Grep search completed successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
