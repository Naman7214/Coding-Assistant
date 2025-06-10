from fastapi import APIRouter, Depends

from system.backend.app.controllers.workspace_indexing_controller import (
    WorkspaceIndexingController,
)

router = APIRouter()


# @router.post("/index-workspace-chunks")
# async def index_workspace_chunks(
#     request: Request,
#     workspace_indexing_controller: WorkspaceIndexingController = Depends(
#         WorkspaceIndexingController
#     ),
# ):
#     """
#     Index workspace chunks from client.

#     Expects:
#     - Content-Type: application/json
#     - Content-Encoding: gzip
#     - Body: gzipped JSON payload with workspace_hash, chunks array, and timestamp

#     Returns:
#     - Processing statistics and success/error information
#     """
#     return await workspace_indexing_controller.index_workspace_chunks(request)


@router.get("/workspace-stats/{workspace_hash}")
async def get_workspace_stats(
    workspace_hash: str,
    workspace_indexing_controller: WorkspaceIndexingController = Depends(
        WorkspaceIndexingController
    ),
):
    """
    Get statistics for a workspace's indexed chunks.

    Args:
        workspace_hash: The unique hash identifier for the workspace

    Returns:
        Statistics about total chunks, languages, chunk types, git branches, etc.
    """
    return await workspace_indexing_controller.get_workspace_stats(
        workspace_hash
    )
