import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import PyMongoError

from agent.config.settings import settings

logger = logging.getLogger(__name__)


class MongoDBMemory:
    """
    Simple MongoDB memory implementation that stores conversations without schemas.
    Each conversation is stored with a session ID.
    """

    def __init__(self):
        self.client = AsyncIOMotorClient(settings.MONGODB_URI)
        self.db = self.client[settings.MONGODB_DB_NAME]
        self.collection = self.db[settings.MONGODB_CONVERSATION_COLLECTION]
        logger.info(
            f"MongoDB memory initialized with database: {settings.MONGODB_DB_NAME}"
        )

    async def create_session(self, session_id: Optional[str] = None) -> str:
        """
        Creates a new conversation session.

        Args:
            session_id: Optional session ID. If not provided, a new UUID will be generated.

        Returns:
            The session ID.
        """
        if not session_id:
            session_id = str(uuid.uuid4())

        try:
            await self.collection.insert_one(
                {
                    "session_id": session_id,
                    "created_at": datetime.utcnow(),
                    "updated_at": datetime.utcnow(),
                    "messages": [],
                    "tool_count": 0,
                    "iteration_count": 0
                }
            )
            logger.info(
                f"Created new conversation session with ID: {session_id}"
            )
        except PyMongoError as e:
            logger.error(f"Error creating conversation session: {e}")
            raise

        return session_id

    async def add_message(
        self, session_id: str, message: Dict[str, Any]
    ) -> None:
        """
        Adds a message to the conversation history.

        Args:
            session_id: The session ID.
            message: The message to add.
        """
        try:
            # Add the new message to the history
            await self.collection.update_one(
                {"session_id": session_id},
                {
                    "$push": {"messages": message},
                    "$set": {"updated_at": datetime.utcnow()},
                },
            )
            logger.debug(
                f"Added message to session {session_id}: {message['role']}"
            )
        except PyMongoError as e:
            logger.error(f"Error adding message to conversation: {e}")
            raise

    async def update_counts(self, session_id: str, tool_count: int, iteration_count: int) -> None:
        """
        Updates the tool and iteration counts for a session.

        Args:
            session_id: The session ID.
            tool_count: The updated tool count.
            iteration_count: The updated iteration count.
        """
        try:
            await self.collection.update_one(
                {"session_id": session_id},
                {
                    "$set": {
                        "tool_count": tool_count,
                        "iteration_count": iteration_count,
                        "updated_at": datetime.utcnow()
                    }
                }
            )
            logger.debug(
                f"Updated counts for session {session_id}: tools={tool_count}, iterations={iteration_count}"
            )
        except PyMongoError as e:
            logger.error(f"Error updating counts: {e}")
            raise

    async def get_conversation_history(
        self, session_id: str
    ) -> List[Dict[str, Any]]:
        """
        Retrieves the conversation history for a session.

        Args:
            session_id: The session ID.

        Returns:
            The conversation history as a list of messages.
        """
        try:
            session = await self.collection.find_one({"session_id": session_id})
            if not session:
                logger.warning(f"Session not found: {session_id}")
                return []

            return session.get("messages", [])

        except PyMongoError as e:
            logger.error(f"Error retrieving conversation history: {e}")
            raise
            
    async def get_session_counts(
        self, session_id: str
    ) -> Tuple[int, int]:
        """
        Retrieves the tool count and iteration count for a session.

        Args:
            session_id: The session ID.

        Returns:
            A tuple of (tool_count, iteration_count)
        """
        try:
            session = await self.collection.find_one({"session_id": session_id})
            if not session:
                logger.warning(f"Session not found: {session_id}")
                return (0, 0)

            tool_count = session.get("tool_count", 0)
            iteration_count = session.get("iteration_count", 0)
            return (tool_count, iteration_count)

        except PyMongoError as e:
            logger.error(f"Error retrieving session counts: {e}")
            raise
