from fastapi import Depends
from fastapi import APIRouter

from src.app.utils.error_handler import handle_exceptions
from src.app.models.schemas.file_access_schemas import FileReadRequest, FilesDeleteRequest, DirectoryListRequest, FileSearchRequest, SearchReplaceRequest
from src.app.controllers.file_access_tools.file_read_controller import FileReadController 
from src.app.controllers.file_access_tools.file_deletion_controller import FileDeletionController
from src.app.controllers.file_access_tools.directory_list_controller import DirectoryListController
from src.app.controllers.file_access_tools.file_search_controller import FileSearchController

router = APIRouter(prefix="/files", tags=["files"])

@router.post("/read-file")
@handle_exceptions
async def read_file(request: FileReadRequest, file_read_controller: FileReadController = Depends(FileReadController)):

    return await file_read_controller.execute(request)

@router.post("/delete-file")
@handle_exceptions
async def delete_file(request: FilesDeleteRequest, file_deletion_controller: FileDeletionController = Depends(FileDeletionController)):

    return await file_deletion_controller.execute(request)

@router.post("/list-directory")
@handle_exceptions
async def list_directory(request: DirectoryListRequest, directory_list_controller: DirectoryListController = Depends(DirectoryListController)):

    return await directory_list_controller.execute(request)

@router.post("/search-files")
@handle_exceptions
async def search_files(request: FileSearchRequest, file_search_controller: FileSearchController = Depends(FileSearchController)):

    return await file_search_controller.execute(request)