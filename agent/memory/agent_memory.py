import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import PyMongoError

from agent.config.settings import settings
from agent.prompts.summery_generation_prompt import (
    SUMMARY_GENERATION_SYSTEM_PROMPT,
    SUMMARY_GENERATION_USER_PROMPT,
)

logger = logging.getLogger(__name__)


class MongoDBMemory:
    """
    Handles storage and retrieval of agent conversation history using MongoDB.
    Implements a sliding window approach with summarization for long conversations.
    """

    def __init__(self):
        self.client = AsyncIOMotorClient(settings.MONGODB_URI)
        self.db = self.client[settings.MONGODB_DB_NAME]
        self.collection = self.db[settings.MONGODB_CONVERSATION_COLLECTION]
        self.window_size = 5  # Number of recent messages to keep in full detail
        logger.info(
            f"MongoDB memory initialized with database: {settings.MONGODB_DB_NAME}"
        )
        self.timeout = httpx.Timeout(
            connect=60.0, read=300.0, write=300.0, pool=60.0
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
                    "summary": None,
                    "window_start_index": 0,
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
        Adds a message to the conversation history and manages the sliding window.

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

            # Get the updated conversation data
            session_data = await self.collection.find_one(
                {"session_id": session_id}
            )
            if not session_data:
                logger.warning(
                    f"Session not found after adding message: {session_id}"
                )
                return

            messages = session_data.get("messages", [])
            window_start_index = session_data.get("window_start_index", 0)

            # Check if we need to update the sliding window
            if len(messages) - window_start_index > self.window_size * 2:
                # We have at least 2x window_size messages since the last window start
                # Time to summarize the older part and move the window
                await self._update_sliding_window(session_id, session_data)

        except PyMongoError as e:
            logger.error(f"Error adding message to conversation: {e}")
            raise

    async def _update_sliding_window(
        self, session_id: str, session_data: Dict[str, Any]
    ) -> None:
        """
        Updates the sliding window by summarizing older messages and updating the window start index.

        Args:
            session_id: The session ID.
            session_data: The current session data from MongoDB.
        """
        messages = session_data.get("messages", [])
        window_start_index = session_data.get("window_start_index", 0)
        current_summary = session_data.get("summary")

        # Calculate the range of messages to summarize
        messages_to_summarize = messages[
            window_start_index : window_start_index + self.window_size
        ]
        new_window_start_index = window_start_index + self.window_size

        if not messages_to_summarize:
            return

        # Generate a summary of these messages
        summary = await self._generate_summary(
            messages_to_summarize, current_summary
        )

        # Update the session with the new summary and window start index
        await self.collection.update_one(
            {"session_id": session_id},
            {
                "$set": {
                    "summary": summary,
                    "window_start_index": new_window_start_index,
                }
            },
        )
        logger.info(
            f"Updated sliding window for session {session_id}, new window starts at index {new_window_start_index}"
        )

    async def _generate_summary(
        self,
        messages: List[Dict[str, Any]],
        previous_summary: Optional[str] = None,
    ) -> str:
        """
        Generates a summary of the given messages using OpenAI API.

        Args:
            messages: The messages to summarize.
            previous_summary: Optional previous summary to incorporate.

        Returns:
            A summary of the messages.
        """
        try:
            # Prepare the content for the OpenAI API
            formatted_messages = []

            system_content = SUMMARY_GENERATION_SYSTEM_PROMPT.format(
                previous_summary=previous_summary
            )

            formatted_messages.append(
                {"role": "system", "content": system_content}
            )

            # Add the conversation to summarize
            conversation_text = ""
            for msg in messages:
                role = msg.get("role", "unknown")
                content = msg.get("content", "")

                # Handle tool calls differently
                if role == "assistant" and "tool_call" in msg:
                    tool_info = f"Tool: {msg['tool_call']['name']}, Params: {json.dumps(msg['tool_call']['parameters'])}"
                    conversation_text += (
                        f"Assistant (using tool): {tool_info}\n"
                    )
                elif role == "tool":
                    tool_result = (
                        f"Tool {msg.get('name', 'unknown')}: {content}"
                    )
                    conversation_text += f"{tool_result}\n"
                else:
                    conversation_text += f"{role.capitalize()}: {content}\n"

            formatted_messages.append(
                {
                    "role": "user",
                    "content": SUMMARY_GENERATION_USER_PROMPT.format(
                        conversation=conversation_text
                    ),
                }
            )

            # Call the OpenAI API
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
                    },
                    json={
                        "model": settings.OPENAI_MODEL,
                        "messages": formatted_messages,
                    },
                )

                if response.status_code != 200:
                    logger.error(
                        f"OpenAI API error: {response.status_code} - {response.text}"
                    )
                    return previous_summary or "Failed to generate summary."

                response_data = response.json()
                summary = (
                    response_data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                )

                if not summary:
                    logger.warning("Empty summary returned from OpenAI API")
                    return previous_summary or "Failed to generate summary."

                return summary

        except Exception as e:
            logger.error(f"Error generating summary: {e}")
            return (
                previous_summary
                or "Failed to generate summary due to an error."
            )

    async def get_conversation_history(
        self, session_id: str
    ) -> List[Dict[str, Any]]:
        """
        Retrieves the conversation history for a session, including the summary if available.

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

            messages = session.get("messages", [])
            summary = session.get("summary")
            window_start_index = session.get("window_start_index", 0)

            # If we have a summary, include it as the first message
            result = []
            if summary and window_start_index > 0:
                result.append(
                    {
                        "role": "system",
                        "content": f"Summary of previous conversation: {summary}",
                    }
                )

            # Add the recent messages
            result.extend(messages[window_start_index:])

            return result

        except PyMongoError as e:
            logger.error(f"Error retrieving conversation history: {e}")
            raise

    async def get_full_conversation_history(
        self, session_id: str
    ) -> List[Dict[str, Any]]:
        """
        Retrieves the full conversation history for a session without summarization.

        Args:
            session_id: The session ID.

        Returns:
            The full conversation history as a list of messages.
        """
        try:
            session = await self.collection.find_one({"session_id": session_id})
            if not session:
                logger.warning(f"Session not found: {session_id}")
                return []
            return session.get("messages", [])
        except PyMongoError as e:
            logger.error(f"Error retrieving full conversation history: {e}")
            raise
