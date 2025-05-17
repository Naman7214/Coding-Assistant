from fastapi import Depends

from src.app.models.schemas.code_base_search_schema import (
    CodeBaseSearchQueryRequest,
)
from src.app.models.schemas.grep_search_query_schema import (
    GrepSearchQueryRequest,
)
from src.app.usecases.search_tools.code_base_usecase import (
    CodeBaseSearchUsecase,
)
from src.app.usecases.search_tools.grep_search_usecase import GrepSearchUsecase


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
        return await self.code_base_search_usecase.process_query(request)

    async def process_grep_query(self, request: GrepSearchQueryRequest):
        return await self.grep_search_usecase.execute_grep_search(request)
