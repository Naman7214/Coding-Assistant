from fastapi import Depends, status
from fastapi.responses import JSONResponse

from backend.app.models.schemas.web_search_query_schema import (
    WebSearchQueryRequest,
)
from backend.app.usecases.external_tools.web_search_usecase import (
    WebSearchUsecase,
)


class WebSearchController:
    def __init__(
        self, web_search_usecase: WebSearchUsecase = Depends(WebSearchUsecase)
    ):
        self.web_search_usecase = web_search_usecase

    async def web_search(self, request: WebSearchQueryRequest):
        result = await self.web_search_usecase.web_search(request)
        return JSONResponse(
            content={
                "data": result,
                "message": "Web search completed successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
