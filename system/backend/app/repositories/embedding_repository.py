from typing import Dict, List

from fastapi import Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorCollection
from pymongo import IndexModel

from system.backend.app.config.database import mongodb_database
from system.backend.app.config.settings import settings
from system.backend.app.utils.logging_util import loggers


class EmbeddingRepository:
    def __init__(
        self, mongodb_client=Depends(mongodb_database.get_mongo_client)
    ):
        self.mongodb_client = mongodb_client
        self.db_name = settings.MONGODB_DB_NAME
        self.collection_name = settings.EMBEDDING_COLLECTION_NAME

    async def _get_or_create_collection(self) -> AsyncIOMotorCollection:
        """Get or create MongoDB collection for embeddings"""
        try:
            collection = self.mongodb_client[self.db_name][self.collection_name]

            # Check if collection exists and create indexes if needed
            collections = await self.mongodb_client[
                self.db_name
            ].list_collection_names()
            if self.collection_name not in collections:
                # Create indexes for efficient querying
                index_models = [
                    IndexModel([("chunk_hash", 1)], unique=True),
                    IndexModel([("created_at", -1)]),
                ]
                await collection.create_indexes(index_models)
                loggers["main"].info(
                    f"Created new global embeddings collection '{self.collection_name}' with indexes"
                )

            return collection

        except Exception as e:
            loggers["main"].error(
                f"Error getting/creating embeddings collection: {str(e)}"
            )
            raise HTTPException(
                status_code=500,
                detail=f"Error accessing embeddings collection: {str(e)}",
            )

    async def get_embeddings_by_hashes(
        self, chunk_hashes: List[str]
    ) -> Dict[str, List[float]]:
        """Get embeddings for given chunk hashes"""
        try:
            collection = await self._get_or_create_collection()

            cursor = collection.find(
                {"chunk_hash": {"$in": chunk_hashes}},
                {"chunk_hash": 1, "embedding": 1, "_id": 0},
            )

            embeddings_map = {}
            async for doc in cursor:
                embeddings_map[doc["chunk_hash"]] = doc["embedding"]

            loggers["main"].info(
                f"Retrieved {len(embeddings_map)} embeddings from global collection"
            )
            return embeddings_map

        except Exception as e:
            loggers["main"].error(f"Error retrieving embeddings: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Error retrieving embeddings: {str(e)}",
            )

    async def store_embeddings_batch(
        self, embeddings_data: List[Dict[str, any]]
    ) -> int:
        """Store multiple embeddings in batch operation"""
        try:
            if not embeddings_data:
                return 0

            collection = await self._get_or_create_collection()

            # Prepare bulk operations
            from datetime import datetime

            from pymongo import UpdateOne

            operations = []
            for embedding_item in embeddings_data:
                embedding_item["created_at"] = datetime.now()
                operations.append(
                    UpdateOne(
                        {"chunk_hash": embedding_item["chunk_hash"]},
                        {"$set": embedding_item},
                        upsert=True,
                    )
                )

            # Execute bulk operation
            result = await collection.bulk_write(operations, ordered=False)
            stored_count = result.upserted_count + result.modified_count

            loggers["main"].info(
                f"Stored {stored_count} embeddings in global collection"
            )
            return stored_count

        except Exception as e:
            loggers["main"].error(f"Error storing embeddings: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Error storing embeddings: {str(e)}",
            )

    async def delete_embeddings_by_hashes(self, chunk_hashes: List[str]) -> int:
        """Delete embeddings by chunk hashes (optional cleanup)"""
        try:
            collection = await self._get_or_create_collection()

            result = await collection.delete_many(
                {"chunk_hash": {"$in": chunk_hashes}}
            )
            deleted_count = result.deleted_count

            loggers["main"].info(
                f"Deleted {deleted_count} embeddings from global collection"
            )
            return deleted_count

        except Exception as e:
            loggers["main"].error(f"Error deleting embeddings: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Error deleting embeddings: {str(e)}",
            )

    async def get_embedding_stats(self) -> Dict[str, int]:
        """Get statistics about embeddings collection"""
        try:
            collection = await self._get_or_create_collection()
            total_count = await collection.count_documents({})

            return {"total_embeddings": total_count}

        except Exception as e:
            loggers["main"].error(f"Error getting embedding stats: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Error getting embedding stats: {str(e)}",
            )
