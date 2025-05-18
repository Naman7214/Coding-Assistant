from fastapi import APIRouter, Depends

from src.app.controllers.external_tools.web_search_controller import (
    WebSearchController,
)
from src.app.models.schemas.web_search_query_schema import WebSearchQueryRequest

router = APIRouter()


@router.post("/web-search")
async def web_search(
    request: WebSearchQueryRequest,
    web_search_controller: WebSearchController = Depends(WebSearchController),
):
    return await web_search_controller.web_search(request)
