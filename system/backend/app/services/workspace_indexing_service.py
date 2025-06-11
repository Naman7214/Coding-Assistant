import asyncio
import gzip
import json
import time
from datetime import datetime
from typing import Dict, List, Tuple

from fastapi import Depends, HTTPException, status

from system.backend.app.config.settings import settings
from system.backend.app.models.domain.chunk import Chunk
from system.backend.app.models.domain.error import Error
from system.backend.app.models.schemas.chunk_indexing_schema import ChunkData
from system.backend.app.repositories.chunk_repository import ChunkRepository
from system.backend.app.repositories.embedding_repository import (
    EmbeddingRepository,
)
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.search_tools.embedding_service import (
    EmbeddingService,
)
from system.backend.app.services.search_tools.pinecone_service import (
    PineconeService,
)
from system.backend.app.utils.logging_util import loggers


class WorkspaceIndexingService:
    def __init__(
        self,
        chunk_repository: ChunkRepository = Depends(ChunkRepository),
        embedding_repository: EmbeddingRepository = Depends(
            EmbeddingRepository
        ),
        embedding_service: EmbeddingService = Depends(EmbeddingService),
        pinecone_service: PineconeService = Depends(PineconeService),
        error_repository: ErrorRepo = Depends(ErrorRepo),
    ):
        self.chunk_repository = chunk_repository
        self.embedding_repository = embedding_repository
        self.embedding_service = embedding_service
        self.pinecone_service = pinecone_service
        self.error_repository = error_repository

        # Settings from configuration
        self.embed_model_name = settings.INDEXING_EMBED_MODEL_NAME
        self.dimension = settings.INDEXING_DIMENSION
        self.similarity_metric = settings.INDEXING_SIMILARITY_METRIC
        self.chunk_size = settings.INDEXING_CHUNK_SIZE
        self.upsert_batch_size = settings.INDEXING_UPSERT_BATCH_SIZE
        self.process_batch_size = settings.INDEXING_PROCESS_BATCH_SIZE
        self.semaphore = asyncio.Semaphore(settings.INDEXING_SEMAPHORE_VALUE)

    async def decompress_gzip_payload(self, compressed_data: bytes) -> Dict:
        """Decompress gzip-compressed payload"""
        try:
            loggers["main"].info(
                f"Decompressing gzip payload of {len(compressed_data)} bytes"
            )

            # Log first few bytes to help debug compression issues
            if len(compressed_data) > 10:
                loggers["main"].debug(f"First 10 bytes: {compressed_data[:10]}")

            decompressed_data = gzip.decompress(compressed_data)
            payload = json.loads(decompressed_data.decode("utf-8"))

            loggers["main"].info(
                f"Successfully decompressed payload with {len(payload.get('chunks', []))} chunks"
            )
            return payload

        except gzip.BadGzipFile as e:
            error_msg = f"Invalid gzip data: {str(e)}"
            if len(compressed_data) > 0:
                # Show first few characters to help debug
                preview = (
                    compressed_data[:50]
                    if len(compressed_data) > 50
                    else compressed_data
                )
                try:
                    # Try to decode as string to see if it's plain text
                    text_preview = preview.decode("utf-8", errors="replace")
                    error_msg += f" (Preview: {text_preview})"
                except:
                    error_msg += f" (Binary preview: {preview})"

            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=error_msg,
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg
            )
        except json.JSONDecodeError as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Invalid JSON in payload: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid JSON in payload: {str(e)}",
            )
        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error decompressing payload: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error decompressing payload: {str(e)}",
            )

    async def identify_and_prepare_chunks_with_embeddings(
        self, workspace_hash: str, incoming_chunks: List[ChunkData]
    ) -> Tuple[List[Chunk], List[ChunkData], int]:
        """Identify chunks and prepare them with embeddings from global collection or generate new ones"""
        try:
            # Get all incoming chunk hashes
            incoming_hashes_raw = [
                chunk.raw_chunk_hash for chunk in incoming_chunks
            ]

            # Get existing embeddings from global collection
            existing_embeddings = (
                await self.embedding_repository.get_embeddings_by_hashes(
                    incoming_hashes_raw
                )
            )

            # Separate chunks that need new embeddings vs those with existing embeddings
            chunks_needing_embeddings = []
            chunks_with_embeddings = []

            for chunk_data in incoming_chunks:
                if chunk_data.raw_chunk_hash in existing_embeddings:
                    chunk = Chunk(
                        chunk_hash=chunk_data.chunk_hash,
                        raw_chunk_hash=chunk_data.raw_chunk_hash,
                        obfuscated_path=chunk_data.obfuscated_path,
                        start_line=chunk_data.start_line,
                        end_line=chunk_data.end_line,
                        language=chunk_data.language,
                        chunk_type=chunk_data.chunk_type,
                        git_branch=chunk_data.git_branch,
                        token_count=chunk_data.token_count,
                        embedding=existing_embeddings[
                            chunk_data.raw_chunk_hash
                        ],
                        created_at=datetime.now(),
                        updated_at=datetime.now(),
                    )
                    chunks_with_embeddings.append(chunk)
                else:
                    # Needs new embedding
                    chunks_needing_embeddings.append(chunk_data)

            # Generate embeddings for chunks that need them
            new_embeddings_generated = 0
            if chunks_needing_embeddings:
                new_chunks_with_embeddings = (
                    await self.generate_embeddings_for_chunks(
                        chunks_needing_embeddings
                    )
                )
                chunks_with_embeddings.extend(new_chunks_with_embeddings)
                new_embeddings_generated = len(new_chunks_with_embeddings)

                # Store new embeddings in global collection
                embeddings_to_store = []
                for chunk in new_chunks_with_embeddings:
                    embeddings_to_store.append(
                        {
                            "raw_chunk_hash": chunk.raw_chunk_hash,
                            "embedding": chunk.embedding,
                        }
                    )

                if embeddings_to_store:
                    await self.embedding_repository.store_embeddings_batch(
                        embeddings_to_store
                    )

            loggers["main"].info(
                f"Chunk processing for workspace {workspace_hash}: "
                f"total={len(incoming_chunks)}, reused_embeddings={len(existing_embeddings)}, "
                f"new_embeddings={new_embeddings_generated}"
            )

            return (
                chunks_with_embeddings,
                chunks_needing_embeddings,
                new_embeddings_generated,
            )

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error identifying and preparing chunks: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error identifying and preparing chunks: {str(e)}",
            )

    async def _process_embedding_chunk(
        self, contents: List[str]
    ) -> List[List[float]]:
        """Process a batch of content for embeddings"""
        async with self.semaphore:
            try:
                embeddings = (
                    await self.embedding_service.voyageai_dense_embeddings(
                        self.embed_model_name, self.dimension, contents
                    )
                )
                return embeddings
            except Exception as e:
                await self.error_repository.insert_error(
                    Error(
                        tool_name="workspace_indexing",
                        error_message=f"Error generating embeddings: {str(e)}",
                        timestamp=datetime.now().isoformat(),
                    )
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Error generating embeddings: {str(e)}",
                )

    async def generate_embeddings_for_chunks(
        self, new_chunks: List[ChunkData]
    ) -> List[Chunk]:
        """Generate embeddings for new chunks"""
        try:
            if not new_chunks:
                return []

            loggers["main"].info(
                f"Generating embeddings for {len(new_chunks)} new chunks"
            )

            # Extract content for embedding generation
            contents = [chunk.content for chunk in new_chunks]

            # Process in batches to respect API limits
            all_embeddings = []
            content_batches = [
                contents[i : i + self.chunk_size]
                for i in range(0, len(contents), self.chunk_size)
            ]

            # Process batches concurrently
            tasks = [
                self._process_embedding_chunk(batch)
                for batch in content_batches
            ]

            batch_results = await asyncio.gather(*tasks)

            # Flatten results
            for batch_embeddings in batch_results:
                all_embeddings.extend(batch_embeddings)

            # Create Chunk objects with embeddings
            chunks_with_embeddings = []
            for i, chunk_data in enumerate(new_chunks):
                chunk = Chunk(
                    chunk_hash=chunk_data.chunk_hash,
                    raw_chunk_hash=chunk_data.raw_chunk_hash,
                    obfuscated_path=chunk_data.obfuscated_path,
                    start_line=chunk_data.start_line,
                    end_line=chunk_data.end_line,
                    language=chunk_data.language,
                    chunk_type=chunk_data.chunk_type,
                    git_branch=chunk_data.git_branch,
                    token_count=chunk_data.token_count,
                    embedding=all_embeddings[i],
                    created_at=datetime.now(),
                    updated_at=datetime.now(),
                )
                chunks_with_embeddings.append(chunk)

            loggers["main"].info(
                f"Successfully generated embeddings for {len(chunks_with_embeddings)} chunks"
            )
            return chunks_with_embeddings

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error generating embeddings for chunks: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error generating embeddings for chunks: {str(e)}",
            )

    async def store_chunks_in_mongodb(
        self, workspace_hash: str, chunks: List[Chunk]
    ) -> Dict[str, int]:
        """Store chunks with embeddings in MongoDB"""
        try:
            if not chunks:
                return {"inserted": 0, "updated": 0}

            loggers["main"].info(
                f"Storing {len(chunks)} chunks in MongoDB for workspace {workspace_hash}"
            )

            result = await self.chunk_repository.upsert_chunks_batch(
                workspace_hash, chunks
            )

            loggers["main"].info(
                f"Successfully stored chunks in MongoDB: "
                f"inserted={result['inserted']}, updated={result['updated']}"
            )

            return result

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error storing chunks in MongoDB: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error storing chunks in MongoDB: {str(e)}",
            )

    async def _get_or_create_pinecone_index(self, workspace_hash: str) -> str:
        """Get or create Pinecone index for workspace"""
        try:
            index_name = workspace_hash

            # List existing indexes
            list_result = await self.pinecone_service.list_pinecone_indexes()
            indexes = list_result.get("indexes", [])
            index_names = [index.get("name") for index in indexes]

            if index_name not in index_names:
                # Create new index
                loggers["main"].info(
                    f"Creating new Pinecone index: {index_name}"
                )
                create_result = await self.pinecone_service.create_index(
                    index_name=index_name,
                    dimension=self.dimension,
                    metric=self.similarity_metric,
                )
                return create_result.get("host")
            else:
                # Get existing index host
                for index in indexes:
                    if index.get("name") == index_name:
                        loggers["main"].info(
                            f"Using existing Pinecone index: {index_name}"
                        )
                        return index.get("host")

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Could not get index host",
            )

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error with Pinecone index: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error with Pinecone index: {str(e)}",
            )

    async def _upsert_batch_to_pinecone(
        self, index_host: str, batch: List[Chunk], namespace: str
    ) -> Dict:
        """Upsert a batch of chunks to Pinecone"""
        try:
            if not batch:
                return {"upserted_count": 0}

            # Convert chunks to embeddings list
            embeddings = [chunk.embedding for chunk in batch]

            # Convert chunks to format expected by pinecone service
            chunk_dicts = []
            for chunk in batch:
                chunk_dict = chunk.to_dict()
                chunk_dicts.append(chunk_dict)

            # Format for Pinecone upsert
            upsert_data = await self.pinecone_service.upsert_format(
                chunk_dicts, embeddings
            )

            # Upsert to Pinecone
            result = await self.pinecone_service.upsert_vectors(
                index_host, upsert_data, namespace
            )

            return result

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error upserting batch to Pinecone: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error upserting to Pinecone: {str(e)}",
            )

    async def upsert_chunks_to_pinecone(
        self, workspace_hash: str, all_chunks: List[Chunk], git_branch: str
    ) -> Dict[str, int]:
        """Upsert all chunks to Pinecone vector database"""
        try:
            if not all_chunks:
                return {"upserted_count": 0, "batches_processed": 0}

            loggers["main"].info(
                f"Upserting {len(all_chunks)} chunks to Pinecone for workspace {workspace_hash}"
            )

            # Get or create index
            index_host = await self._get_or_create_pinecone_index(
                workspace_hash
            )

            # Use git_branch as namespace, fallback to "default"
            namespace = git_branch if git_branch else "default"

            # Process in batches
            batches = [
                all_chunks[i : i + self.upsert_batch_size]
                for i in range(0, len(all_chunks), self.upsert_batch_size)
            ]

            total_upserted = 0
            for i, batch in enumerate(batches):
                loggers["main"].info(
                    f"Processing Pinecone batch {i+1}/{len(batches)}"
                )

                result = await self._upsert_batch_to_pinecone(
                    index_host, batch, namespace
                )

                # Handle different response formats
                if "upsertedCount" in result:
                    total_upserted += result["upsertedCount"]
                elif "upserted_count" in result:
                    total_upserted += result["upserted_count"]

            # Add small delay for Pinecone processing
            time.sleep(2)

            loggers["main"].info(
                f"Successfully upserted {total_upserted} vectors to Pinecone in {len(batches)} batches"
            )

            return {
                "upserted_count": total_upserted,
                "batches_processed": len(batches),
            }

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error upserting chunks to Pinecone: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error upserting chunks to Pinecone: {str(e)}",
            )

    async def handle_chunk_level_deletion(
        self, workspace_hash: str, incoming_chunks: List[ChunkData]
    ) -> Tuple[int, int]:
        """Handle deletion of individual chunks that are no longer present"""
        try:
            if not incoming_chunks:
                loggers["main"].info(
                    "No incoming chunks, skipping chunk-level deletion"
                )
                return 0, 0

            # Group incoming chunks by git_branch and obfuscated_path
            incoming_grouped = {}
            for chunk in incoming_chunks:
                path = chunk.obfuscated_path
                branch = chunk.git_branch

                if path not in incoming_grouped:
                    incoming_grouped[path] = {}
                if branch not in incoming_grouped[path]:
                    incoming_grouped[path][branch] = set()

                incoming_grouped[path][branch].add(chunk.chunk_hash)

            # Only process deletions for paths that are present in the incoming payload
            mongodb_deleted_count = 0
            pinecone_deleted_count = 0

            loggers["main"].info(
                f"Processing chunk deletion for {len(incoming_grouped)} unique paths in incoming payload"
            )

            for path, branches_in_path in incoming_grouped.items():
                loggers["main"].info(
                    f"Processing path: '{path}' with {len(branches_in_path)} branches: {list(branches_in_path.keys())}"
                )

                for branch, incoming_hashes in branches_in_path.items():
                    loggers["main"].info(
                        f"Processing branch '{branch}' for path '{path}' - incoming: {len(incoming_hashes)} chunks"
                    )

                    # Get existing chunks for this specific path and branch only
                    existing_hashes = await self.chunk_repository.get_chunk_hashes_by_path_and_branch(
                        workspace_hash, path, branch
                    )

                    loggers["main"].info(
                        f"Found {len(existing_hashes)} existing chunks for path '{path}' on branch '{branch}'"
                    )

                    # Find chunks that exist in DB but are missing in the incoming payload
                    hashes_to_delete = existing_hashes - incoming_hashes

                    if hashes_to_delete:
                        hashes_to_delete_list = list(hashes_to_delete)

                        loggers["main"].info(
                            f"🗑️  DELETING {len(hashes_to_delete)} chunks for path '{path}' ONLY from branch '{branch}'"
                        )

                        # Delete from MongoDB workspace collection (branch-specific)
                        mongodb_deleted = await self.chunk_repository.delete_chunks_by_hashes_and_branch(
                            workspace_hash, hashes_to_delete_list, branch
                        )
                        mongodb_deleted_count += mongodb_deleted

                        # Delete from Pinecone (branch-specific namespace)
                        pinecone_deleted = (
                            await self._delete_chunks_from_pinecone(
                                workspace_hash, hashes_to_delete_list, branch
                            )
                        )
                        pinecone_deleted_count += pinecone_deleted

                        loggers["main"].info(
                            f"✅ Successfully deleted {mongodb_deleted} from MongoDB and {pinecone_deleted} from Pinecone namespace '{branch}'"
                        )
                    else:
                        loggers["main"].info(
                            f"✨ No chunks to delete for path '{path}' on branch '{branch}' - all chunks are up to date"
                        )

            if mongodb_deleted_count == 0 and pinecone_deleted_count == 0:
                loggers["main"].info(
                    "No individual chunks needed to be deleted"
                )
            else:
                loggers["main"].info(
                    f"Successfully deleted {mongodb_deleted_count} chunks from workspace collection and {pinecone_deleted_count} from Pinecone"
                )

            return mongodb_deleted_count, pinecone_deleted_count

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error handling chunk-level deletion: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error handling chunk-level deletion: {str(e)}",
            )

    async def handle_deleted_files(
        self,
        workspace_hash: str,
        deleted_files_obfuscated_paths: List[str],
        current_git_branch: str = "default",
    ) -> Tuple[int, int]:
        """Handle deletion of chunks for deleted files in specific git branch"""
        try:
            if not deleted_files_obfuscated_paths:
                return 0, 0

            loggers["main"].info(
                f"Handling branch-specific deletion for {len(deleted_files_obfuscated_paths)} files in workspace {workspace_hash} on branch {current_git_branch}"
            )

            # Step 1: Find chunks with matching obfuscated paths AND git branch
            chunks_to_delete = await self.chunk_repository.get_chunks_by_obfuscated_paths_and_branch(
                workspace_hash,
                deleted_files_obfuscated_paths,
                current_git_branch,
            )

            if not chunks_to_delete:
                loggers["main"].info(
                    "No chunks found for deleted files in the specified branch"
                )
                return 0, 0

            chunk_hashes_to_delete = [
                chunk.chunk_hash for chunk in chunks_to_delete
            ]

            loggers["main"].info(
                f"Found {len(chunks_to_delete)} chunks to delete for {len(deleted_files_obfuscated_paths)} deleted files on branch {current_git_branch}"
            )

            # Step 2: Delete from MongoDB workspace collection (branch-specific)
            mongodb_deleted_count = 0
            if chunk_hashes_to_delete:
                mongodb_deleted_count = await self.chunk_repository.delete_chunks_by_hashes_and_branch(
                    workspace_hash, chunk_hashes_to_delete, current_git_branch
                )

            # Step 3: Delete from Pinecone (branch-specific namespace)
            pinecone_deleted_count = 0
            if chunk_hashes_to_delete:
                pinecone_deleted_count = (
                    await self._delete_chunks_from_pinecone(
                        workspace_hash,
                        chunk_hashes_to_delete,
                        current_git_branch,
                    )
                )

            loggers["main"].info(
                f"Successfully deleted {mongodb_deleted_count} chunks from MongoDB and {pinecone_deleted_count} vectors from Pinecone on branch {current_git_branch}"
            )

            return mongodb_deleted_count, pinecone_deleted_count

        except Exception as e:
            await self.error_repository.insert_error(
                Error(
                    tool_name="workspace_indexing",
                    error_message=f"Error handling deleted files: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error handling deleted files: {str(e)}",
            )

    async def _delete_chunks_from_pinecone(
        self, workspace_hash: str, chunk_hashes: List[str], git_branch: str
    ) -> int:
        """Delete specific chunks from Pinecone by hash"""
        try:
            if not chunk_hashes:
                return 0

            # Get or create index
            index_host = await self._get_or_create_pinecone_index(
                workspace_hash
            )

            # Use git_branch as namespace
            namespace = git_branch if git_branch else "default"

            # Delete vectors in batches (Pinecone has limits)
            batch_size = 100  # Conservative batch size for deletions
            total_deleted = 0

            for i in range(0, len(chunk_hashes), batch_size):
                batch_hashes = chunk_hashes[i : i + batch_size]

                try:
                    result = await self.pinecone_service.delete_vectors(
                        index_host, batch_hashes, namespace
                    )

                    # Handle different response formats
                    if isinstance(result, dict) and "deleted" in result:
                        total_deleted += result["deleted"]
                    else:
                        # Assume success if no error
                        total_deleted += len(batch_hashes)

                except Exception as e:
                    loggers["main"].warning(
                        f"Failed to delete batch {i//batch_size + 1} from Pinecone: {str(e)}"
                    )
                    # Continue with other batches even if one fails

            loggers["main"].info(
                f"Deleted {total_deleted} vectors from Pinecone namespace '{namespace}'"
            )

            return total_deleted

        except Exception as e:
            loggers["main"].error(
                f"Error deleting chunks from Pinecone: {str(e)}"
            )
            # Don't raise exception for Pinecone deletion failures, just log
            return 0
