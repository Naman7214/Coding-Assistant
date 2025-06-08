import time
from datetime import datetime
from typing import Dict

from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.models.schemas.chunk_indexing_schema import (
    ChunkData,
    ChunkProcessingStats,
    WorkspaceIndexingResponse,
)
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.workspace_indexing_service import (
    WorkspaceIndexingService,
)
from system.backend.app.utils.logging_util import loggers


class WorkspaceIndexingUseCase:
    def __init__(
        self,
        workspace_indexing_service: WorkspaceIndexingService = Depends(
            WorkspaceIndexingService
        ),
        error_repository: ErrorRepo = Depends(ErrorRepo),
    ):
        self.workspace_indexing_service = workspace_indexing_service
        self.error_repository = error_repository

    async def process_workspace_chunks(
        self, compressed_payload: bytes
    ) -> WorkspaceIndexingResponse:
        """Main orchestration method for processing workspace chunks"""
        start_time = time.time()

        try:
            loggers["main"].info("Starting workspace chunk processing")

            # Step 1: Decompress gzip payload
            payload_data = (
                await self.workspace_indexing_service.decompress_gzip_payload(
                    compressed_payload
                )
            )

            # Validate payload structure
            if not isinstance(payload_data, dict):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid payload format",
                )

            # Parse request data
            workspace_hash = payload_data.get("workspace_hash")
            chunks_data = payload_data.get("chunks", [])
            deleted_files_obfuscated_paths = payload_data.get(
                "deleted_files_obfuscated_paths", []
            )
            current_git_branch = payload_data.get(
                "current_git_branch", "default"
            )
            timestamp = payload_data.get("timestamp")

            if not workspace_hash:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="workspace_hash is required",
                )

            loggers["main"].info(
                f"Processing {len(chunks_data)} chunks and {len(deleted_files_obfuscated_paths)} deleted files for workspace {workspace_hash} on branch {current_git_branch}"
            )

            # Convert to ChunkData objects
            chunk_objects = []
            if chunks_data:
                for chunk_dict in chunks_data:
                    try:
                        chunk_obj = ChunkData(**chunk_dict)
                        chunk_objects.append(chunk_obj)
                    except Exception as e:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Invalid chunk data: {str(e)}",
                        )

            # Step 2: Handle deleted files first with branch-specific deletion
            deleted_chunks_count = 0
            pinecone_deleted_count = 0
            if deleted_files_obfuscated_paths:
                deleted_chunks_count, pinecone_deleted_count = (
                    await self.workspace_indexing_service.handle_deleted_files(
                        workspace_hash,
                        deleted_files_obfuscated_paths,
                        current_git_branch,
                    )
                )

            # Step 3: Identify new vs existing chunks
            new_chunks, existing_chunks, existing_hashes = (
                await self.workspace_indexing_service.identify_new_chunks(
                    workspace_hash, chunk_objects
                )
            )

            # Step 4: Generate embeddings only for new chunks
            new_chunks_with_embeddings = []
            embeddings_generated = 0
            if new_chunks:
                new_chunks_with_embeddings = await self.workspace_indexing_service.generate_embeddings_for_chunks(
                    new_chunks
                )
                embeddings_generated = len(new_chunks_with_embeddings)

            # Step 5: Store new chunks in MongoDB
            mongodb_result = {"inserted": 0, "updated": 0}
            if new_chunks_with_embeddings:
                mongodb_result = await self.workspace_indexing_service.store_chunks_in_mongodb(
                    workspace_hash, new_chunks_with_embeddings
                )

            # Step 6: Prepare all chunks for Pinecone upsert (new + existing)
            all_chunks_for_pinecone = (
                new_chunks_with_embeddings + existing_chunks
            )

            # Determine git branch for namespace (use first chunk's git_branch)
            git_branch = "default"
            if chunk_objects:
                git_branch = chunk_objects[0].git_branch or "default"

            # Step 7: Upsert all chunks to Pinecone
            pinecone_result = {"upserted_count": 0, "batches_processed": 0}
            if all_chunks_for_pinecone:
                pinecone_result = await self.workspace_indexing_service.upsert_chunks_to_pinecone(
                    workspace_hash, all_chunks_for_pinecone, git_branch
                )

            # Calculate processing time
            processing_time = time.time() - start_time

            # Create statistics
            stats = ChunkProcessingStats(
                total_chunks=len(chunk_objects),
                existing_chunks=len(existing_chunks),
                new_chunks=len(new_chunks),
                deleted_chunks=deleted_chunks_count,
                embeddings_generated=embeddings_generated,
                pinecone_upserted=pinecone_result["upserted_count"],
                pinecone_deleted=pinecone_deleted_count,
            )

            # Create response
            response = WorkspaceIndexingResponse(
                success=True,
                message="Workspace chunks processed successfully",
                workspace_hash=workspace_hash,
                git_branch=git_branch,
                stats=stats,
                processing_time_seconds=round(processing_time, 2),
            )

            loggers["main"].info(
                f"Workspace indexing completed successfully for {workspace_hash}. "
                f"Time: {processing_time:.2f}s, New: {len(new_chunks)}, "
                f"Existing: {len(existing_chunks)}, Pinecone: {pinecone_result['upserted_count']}"
            )

            return response

        except HTTPException:
            # Re-raise HTTP exceptions as they have proper status codes
            raise
        except Exception as e:
            # Log unexpected errors
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing_usecase",
                    error_message=f"Unexpected error in process_workspace_chunks: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )

            loggers["main"].error(
                f"Unexpected error in workspace indexing: {str(e)}"
            )

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Unexpected error processing workspace chunks: {str(e)}",
            )

    async def get_workspace_stats(self, workspace_hash: str) -> Dict:
        """Get statistics about a workspace's indexed chunks"""
        try:
            loggers["main"].info(
                f"Getting stats for workspace {workspace_hash}"
            )

            # Get all chunks for the workspace
            chunks = await self.workspace_indexing_service.chunk_repository.get_all_chunks(
                workspace_hash
            )

            # Calculate statistics
            total_chunks = len(chunks)
            languages = {}
            chunk_types = {}
            git_branches = {}

            for chunk in chunks:
                # Count by language
                languages[chunk.language] = languages.get(chunk.language, 0) + 1

                # Count by chunk type
                chunk_types[chunk.chunk_type] = (
                    chunk_types.get(chunk.chunk_type, 0) + 1
                )

                # Count by git branch
                git_branches[chunk.git_branch] = (
                    git_branches.get(chunk.git_branch, 0) + 1
                )

            stats = {
                "workspace_hash": workspace_hash,
                "total_chunks": total_chunks,
                "languages": languages,
                "chunk_types": chunk_types,
                "git_branches": git_branches,
                "last_updated": datetime.now().isoformat(),
            }

            loggers["main"].info(
                f"Retrieved stats for workspace {workspace_hash}: {total_chunks} chunks"
            )

            return stats

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing_usecase",
                    error_message=f"Error getting workspace stats: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error getting workspace stats: {str(e)}",
            )
