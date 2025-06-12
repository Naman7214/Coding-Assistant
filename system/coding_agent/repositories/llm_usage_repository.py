from datetime import datetime
from logging import getLogger
from typing import Any, Dict, Optional

from config.settings import settings
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorCollection

logger = getLogger(__name__)


class LLMUsageRepository:
    """Repository for handling LLM usage logging operations with MongoDB"""

    def __init__(self):
        self.mongodb_client: Optional[AsyncIOMotorClient] = None
        self.llm_usage_collection: Optional[AsyncIOMotorCollection] = None
        self._initialize_connection()

    def _initialize_connection(self):
        """Initialize MongoDB connection and collection"""
        try:
            self.mongodb_client = AsyncIOMotorClient(settings.MONGODB_URL)
            self.llm_usage_collection = self.mongodb_client[
                settings.MONGODB_DB_NAME
            ][settings.LLM_USAGE_COLLECTION_NAME]
            logger.info(
                "✅ LLM Usage Repository initialized with MongoDB connection"
            )
        except Exception as e:
            logger.error(
                f"MongoDB connection error in LLMUsageRepository: {str(e)}"
            )
            self.mongodb_client = None
            self.llm_usage_collection = None

    async def log_llm_usage(self, usage_data: Dict[str, Any]) -> bool:
        """
        Log LLM usage data to MongoDB collection

        Args:
            usage_data: Dictionary containing usage information
                Expected keys: input_tokens, output_tokens, total_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                duration, provider, model, request_id, request_type

        Returns:
            bool: True if successfully logged, False otherwise
        """
        try:

            # Prepare the log document with timestamp
            log_document = {**usage_data, "created_at": datetime.utcnow()}

            # Insert the log document
            result = await self.llm_usage_collection.insert_one(log_document)

            if result.inserted_id:
                logger.debug(
                    f"Successfully logged LLM usage with ID: {result.inserted_id}"
                )
                return True
            else:
                logger.error("Failed to insert LLM usage log")
                return False

        except Exception as e:
            logger.error(f"Error logging LLM usage to MongoDB: {str(e)}")
            return False
