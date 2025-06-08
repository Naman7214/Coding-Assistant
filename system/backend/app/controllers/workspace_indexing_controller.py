from fastapi import Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from system.backend.app.usecases.workspace_indexing_usecase import (
    WorkspaceIndexingUseCase,
)
from system.backend.app.utils.logging_util import loggers


class WorkspaceIndexingController:
    def __init__(
        self,
        workspace_indexing_usecase: WorkspaceIndexingUseCase = Depends(
            WorkspaceIndexingUseCase
        ),
    ):
        self.workspace_indexing_usecase = workspace_indexing_usecase

    async def index_workspace_chunks(self, request: Request) -> JSONResponse:
        """Handle workspace chunk indexing requests"""
        try:
            # Check content encoding
            content_encoding = request.headers.get(
                "content-encoding", ""
            ).lower()

            print(f"Content encoding: {content_encoding}")
            if content_encoding != "gzip":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Content-Encoding must be 'gzip'",
                )

            # Check content type
            content_type = request.headers.get("content-type", "").lower()
            print(f" content type : {content_type}")
            if "application/json" not in content_type:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Content-Type must be 'application/json'",
                )

            # Read compressed payload
            compressed_payload = await request.body()

            if not compressed_payload:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Empty request body",
                )

            loggers["main"].info(
                f"Received workspace indexing request with {len(compressed_payload)} bytes of compressed data"
            )

            # Process the workspace chunks
            result = (
                await self.workspace_indexing_usecase.process_workspace_chunks(
                    compressed_payload
                )
            )

            # Return successful response
            return JSONResponse(
                content={
                    "success": result.success,
                    "message": result.message,
                    "data": {
                        "workspace_hash": result.workspace_hash,
                        "git_branch": result.git_branch,
                        "processing_time_seconds": result.processing_time_seconds,
                        "stats": {
                            "total_chunks": result.stats.total_chunks,
                            "existing_chunks": result.stats.existing_chunks,
                            "new_chunks": result.stats.new_chunks,
                            "embeddings_generated": result.stats.embeddings_generated,
                            "pinecone_upserted": result.stats.pinecone_upserted,
                        },
                    },
                    "error": None,
                },
                status_code=status.HTTP_200_OK,
            )

        except HTTPException as e:
            # Re-raise HTTP exceptions with proper error format
            print(f"HTTPException: {e.detail}")
            return JSONResponse(
                content={
                    "success": False,
                    "message": "Workspace indexing failed",
                    "data": None,
                    "error": {
                        "type": "HTTPException",
                        "detail": e.detail,
                        "status_code": e.status_code,
                    },
                },
                status_code=e.status_code,
            )

        except Exception as e:
            # Handle unexpected errors
            loggers["main"].error(
                f"Unexpected error in workspace indexing controller: {str(e)}"
            )

            return JSONResponse(
                content={
                    "success": False,
                    "message": "Internal server error during workspace indexing",
                    "data": None,
                    "error": {
                        "type": "InternalServerError",
                        "detail": str(e),
                        "status_code": 500,
                    },
                },
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

    async def get_workspace_stats(self, workspace_hash: str) -> JSONResponse:
        """Get statistics for a workspace"""
        try:
            if not workspace_hash or not workspace_hash.strip():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="workspace_hash is required",
                )

            loggers["main"].info(
                f"Getting workspace stats for {workspace_hash}"
            )

            # Get workspace statistics
            stats = await self.workspace_indexing_usecase.get_workspace_stats(
                workspace_hash
            )

            return JSONResponse(
                content={
                    "success": True,
                    "message": "Workspace stats retrieved successfully",
                    "data": stats,
                    "error": None,
                },
                status_code=status.HTTP_200_OK,
            )

        except HTTPException as e:
            return JSONResponse(
                content={
                    "success": False,
                    "message": "Failed to get workspace stats",
                    "data": None,
                    "error": {
                        "type": "HTTPException",
                        "detail": e.detail,
                        "status_code": e.status_code,
                    },
                },
                status_code=e.status_code,
            )

        except Exception as e:
            loggers["main"].error(
                f"Unexpected error getting workspace stats: {str(e)}"
            )

            return JSONResponse(
                content={
                    "success": False,
                    "message": "Internal server error getting workspace stats",
                    "data": None,
                    "error": {
                        "type": "InternalServerError",
                        "detail": str(e),
                        "status_code": 500,
                    },
                },
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
