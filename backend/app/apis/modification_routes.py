from fastapi import Depends
from fastapi import APIRouter

from backend.app.utils.error_handler import handle_exceptions
from backend.app.models.schemas.modification_schemas import SearchReplaceRequest, EditFileRequest, ReapplyRequest
from backend.app.controllers.modification_tools.search_replace_controller import SearchReplaceController
from backend.app.controllers.modification_tools.edit_file_controller import EditFileController
from backend.app.controllers.modification_tools.reapply_controller import ReapplyController

router = APIRouter(prefix="/modify", tags=["modification"])

@router.post("/search-replace")
@handle_exceptions
async def search_replace(request: SearchReplaceRequest, search_replace_controller: SearchReplaceController = Depends(SearchReplaceController)):
    return await search_replace_controller.execute(request)

@router.post("/edit-file")
@handle_exceptions
async def edit_file(request: EditFileRequest, edit_file_controller: EditFileController = Depends(EditFileController)):
    return await edit_file_controller.execute(request)

@router.post("/reapply")
@handle_exceptions
async def reapply(request: ReapplyRequest, reapply_controller: ReapplyController = Depends(ReapplyController)):
    return await reapply_controller.execute(request)