from typing import Dict, List, Set

from fastapi import Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorCollection
from pymongo import IndexModel

from system.backend.app.config.database import mongodb_database
from system.backend.app.config.settings import settings
from system.backend.app.models.domain.chunk import Chunk
from system.backend.app.utils.logging_util import loggers


class ChunkRepository:
    def __init__(
        self, mongodb_client=Depends(mongodb_database.get_mongo_client)
    ):
        self.mongodb_client = mongodb_client
        self.db_name = settings.MONGODB_DB_NAME

    def _get_collection_name(self, workspace_hash: str) -> str:
        """Generate collection name from workspace hash"""
        return f"chunks_{workspace_hash}"

    async def _get_or_create_collection(
        self, workspace_hash: str
    ) -> AsyncIOMotorCollection:
        """Get or create MongoDB collection for workspace chunks"""
        try:
            collection_name = self._get_collection_name(workspace_hash)
            collection = self.mongodb_client[self.db_name][collection_name]

            # Check if collection exists and create indexes if needed
            collections = await self.mongodb_client[
                self.db_name
            ].list_collection_names()
            if collection_name not in collections:
                # Create indexes for efficient querying
                index_models = [
                    IndexModel([("chunk_hash", 1)], unique=True),
                    IndexModel([("git_branch", 1)]),
                    IndexModel([("language", 1)]),
                    IndexModel([("chunk_type", 1)]),
                    IndexModel([("created_at", -1)]),
                ]
                await collection.create_indexes(index_models)
                loggers["main"].info(
                    f"Created new collection '{collection_name}' with indexes"
                )

            return collection

        except Exception as e:
            loggers["main"].error(
                f"Error getting/creating collection for workspace {workspace_hash}: {str(e)}"
            )
            raise HTTPException(
                status_code=500,
                detail=f"Error accessing workspace collection: {str(e)}",
            )

    async def get_all_chunks(self, workspace_hash: str) -> List[Chunk]:
        """Get all chunks from workspace collection"""
        try:
            collection = await self._get_or_create_collection(workspace_hash)

            cursor = collection.find({})
            chunks = []

            async for doc in cursor:
                # Remove MongoDB's _id field before converting
                if "_id" in doc:
                    del doc["_id"]
                chunks.append(Chunk.from_dict(doc))

            loggers["main"].info(
                f"Retrieved {len(chunks)} chunks from workspace {workspace_hash}"
            )
            return chunks

        except Exception as e:
            loggers["main"].error(
                f"Error retrieving chunks for workspace {workspace_hash}: {str(e)}"
            )
            raise HTTPException(
                status_code=500, detail=f"Error retrieving chunks: {str(e)}"
            )

    async def get_existing_chunk_hashes(self, workspace_hash: str) -> Set[str]:
        """Get all existing chunk hashes for efficient comparison"""
        try:
            collection = await self._get_or_create_collection(workspace_hash)

            # Only fetch chunk_hash field for efficiency
            cursor = collection.find({}, {"chunk_hash": 1, "_id": 0})
            chunk_hashes = set()

            async for doc in cursor:
                chunk_hashes.add(doc["chunk_hash"])

            loggers["main"].info(
                f"Retrieved {len(chunk_hashes)} existing chunk hashes from workspace {workspace_hash}"
            )
            return chunk_hashes

        except Exception as e:
            loggers["main"].error(
                f"Error retrieving chunk hashes for workspace {workspace_hash}: {str(e)}"
            )
            raise HTTPException(
                status_code=500,
                detail=f"Error retrieving chunk hashes: {str(e)}",
            )

    async def upsert_chunks_batch(
        self, workspace_hash: str, chunks: List[Chunk]
    ) -> Dict[str, int]:
        """Upsert multiple chunks in a single batch operation"""
        try:
            if not chunks:
                return {"inserted": 0, "updated": 0}

            collection = await self._get_or_create_collection(workspace_hash)

            # Prepare bulk operations
            from pymongo import UpdateOne

            operations = []

            for chunk in chunks:
                chunk_dict = chunk.to_dict()
                # Remove None values
                chunk_dict = {
                    k: v for k, v in chunk_dict.items() if v is not None
                }

                operations.append(
                    UpdateOne(
                        {"chunk_hash": chunk.chunk_hash},
                        {"$set": chunk_dict},
                        upsert=True,
                    )
                )

            # Execute bulk operation
            result = await collection.bulk_write(operations, ordered=False)

            stats = {
                "inserted": result.upserted_count,
                "updated": result.modified_count,
                "matched": result.matched_count,
            }

            loggers["main"].info(
                f"Batch upsert completed for workspace {workspace_hash}: "
                f"inserted={stats['inserted']}, updated={stats['updated']}"
            )

            return stats

        except Exception as e:
            loggers["main"].error(
                f"Error upserting chunks batch for workspace {workspace_hash}: {str(e)}"
            )
            raise HTTPException(
                status_code=500, detail=f"Error upserting chunks: {str(e)}"
            )

    async def get_chunks_by_hashes(
        self, workspace_hash: str, chunk_hashes: List[str]
    ) -> List[Chunk]:
        """Get specific chunks by their hashes"""
        try:
            collection = await self._get_or_create_collection(workspace_hash)

            cursor = collection.find({"chunk_hash": {"$in": chunk_hashes}})
            chunks = []

            async for doc in cursor:
                # Remove MongoDB's _id field before converting
                if "_id" in doc:
                    del doc["_id"]
                chunks.append(Chunk.from_dict(doc))

            loggers["main"].info(
                f"Retrieved {len(chunks)} specific chunks from workspace {workspace_hash}"
            )
            return chunks

        except Exception as e:
            loggers["main"].error(
                f"Error retrieving specific chunks for workspace {workspace_hash}: {str(e)}"
            )
            raise HTTPException(
                status_code=500,
                detail=f"Error retrieving specific chunks: {str(e)}",
            )

    async def delete_workspace_chunks(self, workspace_hash: str) -> int:
        """Delete all chunks for a workspace (cleanup operation)"""
        try:
            collection_name = self._get_collection_name(workspace_hash)

            # Drop the entire collection for efficiency
            await self.mongodb_client[self.db_name].drop_collection(
                collection_name
            )

            loggers["main"].info(
                f"Deleted all chunks for workspace {workspace_hash}"
            )
            return 1  # Success indicator

        except Exception as e:
            loggers["main"].error(
                f"Error deleting chunks for workspace {workspace_hash}: {str(e)}"
            )
            raise HTTPException(
                status_code=500,
                detail=f"Error deleting workspace chunks: {str(e)}",
            )
