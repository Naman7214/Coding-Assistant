from fastapi import Depends
from fastapi import APIRouter

from src.app.utils.error_handler import handle_exceptions
from src.app.models.schemas.file_access_schemas import SearchReplaceRequest
from src.app.controllers.modification_tools.search_replace_controller import SearchReplaceController

router = APIRouter(prefix="/modify", tags=["modification"])

@router.post("/search-replace")
@handle_exceptions
async def search_replace(request: SearchReplaceRequest, search_replace_controller: SearchReplaceController = Depends(SearchReplaceController)):

    return await search_replace_controller.execute(request)