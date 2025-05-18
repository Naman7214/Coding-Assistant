from fastapi import APIRouter, Depends

from src.app.controllers.codebase_indexing_controller import (
    CodebaseIndexingController,
)

router = APIRouter()


@router.get("/sync-codebase-index")
async def sync_codebase_index(
    codebase_indexing_controller: CodebaseIndexingController = Depends(
        CodebaseIndexingController
    ),
):
    return await codebase_indexing_controller.sync_codebase_index()
