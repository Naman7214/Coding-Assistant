from fastapi import APIRouter, Depends

from backend.app.controllers.modification_tools.search_replace_controller import (
    SearchReplaceController,
)
from backend.app.models.schemas.file_access_schemas import SearchReplaceRequest
from backend.app.utils.error_handler import handle_exceptions

router = APIRouter(prefix="/modify", tags=["modification"])


@router.post("/search-replace")
@handle_exceptions
async def search_replace(
    request: SearchReplaceRequest,
    search_replace_controller: SearchReplaceController = Depends(
        SearchReplaceController
    ),
):

    return await search_replace_controller.execute(request)
