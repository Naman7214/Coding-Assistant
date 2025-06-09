import asyncio
import json
import time
from datetime import datetime
from typing import AsyncGenerator, Optional

import httpx
from dotenv import load_dotenv
from openai import OpenAI

from system.backend.app.config.settings import settings
from system.backend.app.prompts.file_modification_prompt import (
    FILE_MODIFICATION_PROMPT,
)


class EditFileService:
    def __init__(self):
        self.HF_API_KEY = settings.HUGGINGFACE_API_KEY
        self.BASE_URL = settings.HUGGINGFACE_API_URL
        self.http_client = httpx.Client(verify=False)
        self.client = OpenAI(
            base_url=self.BASE_URL,
            api_key=self.HF_API_KEY,
            http_client=self.http_client,
        )

    async def edit_file(
        self,
        target_file_content: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ):
        try:
            try:
                edited_content = await self._apply_code_changes(
                    target_file_content, code_snippet
                )

                if edited_content is None:
                    raise ValueError("Failed to apply code changes")

                if not isinstance(edited_content, str):
                    raise ValueError("Edited content must be a string")

                if not edited_content:
                    raise ValueError("Edited content cannot be empty")

            except Exception as api_error:
                return {
                    "success": False,
                    "error": f"FastApply model API error: {str(api_error)}",
                    "details": {
                        "target_file_content": target_file_content,
                        "timestamp": datetime.now().isoformat(),
                    },
                }

            return {
                "success": True,
                "details": {
                    "edited_content": edited_content,
                    "timestamp": datetime.now().isoformat(),
                },
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "details": {
                    "target_file_content": target_file_content,
                    "timestamp": datetime.now().isoformat(),
                },
            }

    async def edit_file_stream(
        self,
        target_file_content: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ) -> AsyncGenerator[str, None]:
        """Stream the file editing process as server-sent events"""
        try:
            # Send model preparation event
            yield self._create_sse_event(
                "model_preparation",
                "Initializing model for code generation...",
                {
                    "model": "tgi_dummy",
                    "stage": "model_init",
                    "explanation": explanation,
                },
            )

            # Stream from the dummy model implementation (for testing)
            async for event in self._apply_code_changes_stream_dummy(
                target_file_content, code_snippet
            ):
                yield event

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Service error: {str(e)}",
                {
                    "stage": "service",
                    "timestamp": datetime.now().isoformat(),
                },
            )

    async def _apply_code_changes(
        self, original_code: str, code_snippet: str
    ) -> Optional[str]:
        """
        Apply code changes to the original code using the TGI model.

        Args:
            original_code (str): The original code content
            code_snippet (str): The code snippet to apply

        Returns:
            Optional[str]: The updated code content, or None if failed
        """
        try:
            load_dotenv()

            user_query = FILE_MODIFICATION_PROMPT.format(
                original_code=original_code, code_snippet=code_snippet
            )

            chat_completion = self.client.chat.completions.create(
                model="tgi",
                messages=[{"role": "user", "content": user_query}],
                max_tokens=20000,
                stream=True,
            )

            edited_content = ""
            for message in chat_completion:
                content = message.choices[0].delta.content
                if content:
                    edited_content += content

            if (
                "<updated-code>" in edited_content
                and "</updated-code>" in edited_content
            ):
                start_tag = "<updated-code>"
                end_tag = "</updated-code>"
                start_pos = edited_content.find(start_tag) + len(start_tag)
                end_pos = edited_content.find(end_tag)
                edited_content = edited_content[start_pos:end_pos].strip()

            if not isinstance(edited_content, str):
                raise ValueError("Edited content must be a string")

            if not edited_content:
                raise ValueError("Edited content cannot be empty")

            return edited_content

        except Exception as e:
            print(f"FastApply error: {str(e)}")
            return None

    async def _apply_code_changes_stream(
        self, original_code: str, code_snippet: str
    ) -> AsyncGenerator[str, None]:
        """
        Stream code changes as they are generated by the TGI model.

        Args:
            original_code (str): The original code content
            code_snippet (str): The code snippet to apply

        Yields:
            str: Server-sent events for streaming
        """
        try:
            load_dotenv()

            user_query = FILE_MODIFICATION_PROMPT.format(
                original_code=original_code, code_snippet=code_snippet
            )

            # Send model request event
            yield self._create_sse_event(
                "model_request",
                "Sending request to code generation model...",
                {
                    "model": "tgi",
                    "max_tokens": 20000,
                    "prompt_length": len(user_query),
                },
            )

            chat_completion = self.client.chat.completions.create(
                model="tgi",
                messages=[{"role": "user", "content": user_query}],
                max_tokens=20000,
                stream=True,
            )

            edited_content = ""
            chunk_count = 0
            inside_code_block = False
            code_content = ""

            # Send streaming start event
            yield self._create_sse_event(
                "model_streaming",
                "Receiving streamed response from model...",
                {"status": "streaming_started"},
            )

            for message in chat_completion:
                content = message.choices[0].delta.content
                if content:
                    edited_content += content
                    chunk_count += 1

                    # Check if we're entering or inside the code block
                    if "<updated-code>" in content and not inside_code_block:
                        inside_code_block = True
                        yield self._create_sse_event(
                            "code_generation_start",
                            "Started generating updated code...",
                            {"chunk_count": chunk_count},
                        )
                        # Extract any code content after the tag
                        start_pos = content.find("<updated-code>") + len(
                            "<updated-code>"
                        )
                        if start_pos < len(content):
                            code_chunk = content[start_pos:]
                            if code_chunk.strip():
                                code_content += code_chunk
                                yield self._create_sse_event(
                                    "code_chunk",
                                    code_chunk,
                                    {
                                        "chunk_number": chunk_count,
                                        "total_code_length": len(code_content),
                                        "is_inside_code_block": True,
                                    },
                                )
                    elif inside_code_block and "</updated-code>" not in content:
                        # We're inside the code block, stream the content
                        code_content += content
                        yield self._create_sse_event(
                            "code_chunk",
                            content,
                            {
                                "chunk_number": chunk_count,
                                "total_code_length": len(code_content),
                                "is_inside_code_block": True,
                            },
                        )
                    elif inside_code_block and "</updated-code>" in content:
                        # We're reaching the end of the code block
                        end_pos = content.find("</updated-code>")
                        if end_pos > 0:
                            final_chunk = content[:end_pos]
                            code_content += final_chunk
                            yield self._create_sse_event(
                                "code_chunk",
                                final_chunk,
                                {
                                    "chunk_number": chunk_count,
                                    "total_code_length": len(code_content),
                                    "is_inside_code_block": True,
                                },
                            )

                        inside_code_block = False
                        yield self._create_sse_event(
                            "code_generation_complete",
                            "Code generation completed",
                            {
                                "total_chunks": chunk_count,
                                "final_code_length": len(code_content),
                            },
                        )
                    else:
                        # Stream non-code content for debugging/context
                        yield self._create_sse_event(
                            "model_output",
                            content,
                            {
                                "chunk_number": chunk_count,
                                "is_inside_code_block": False,
                            },
                        )

            # Process the complete response
            final_edited_content = ""
            if (
                "<updated-code>" in edited_content
                and "</updated-code>" in edited_content
            ):
                start_tag = "<updated-code>"
                end_tag = "</updated-code>"
                start_pos = edited_content.find(start_tag) + len(start_tag)
                end_pos = edited_content.find(end_tag)
                final_edited_content = edited_content[start_pos:end_pos].strip()
            else:
                final_edited_content = edited_content.strip()

            # Validation
            if not isinstance(final_edited_content, str):
                raise ValueError("Edited content must be a string")

            if not final_edited_content:
                raise ValueError("Edited content cannot be empty")

            # Send completion event with final result
            yield self._create_sse_event(
                "completion",
                "File editing completed successfully",
                {
                    "success": True,
                    "final_content_length": len(final_edited_content),
                    "total_chunks_processed": chunk_count,
                    "edited_content": final_edited_content,
                    "timestamp": datetime.now().isoformat(),
                },
            )

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Streaming error: {str(e)}",
                {
                    "stage": "model_streaming",
                    "timestamp": datetime.now().isoformat(),
                },
            )

    async def _apply_code_changes_stream_dummy(
        self, original_code: str, code_snippet: str
    ) -> AsyncGenerator[str, None]:
        """
        Dummy implementation that simulates streaming code changes with fake Python code.
        Used for testing when the actual TGI model is unavailable.

        Args:
            original_code (str): The original code content
            code_snippet (str): The code snippet to apply

        Yields:
            str: Server-sent events for streaming
        """
        try:
            # Dummy Python code (~50 lines)
            dummy_code = '''import asyncio
import json
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class UserProfile:
    """Represents a user profile with various attributes."""
    user_id: str
    username: str
    email: str
    created_at: datetime = field(default_factory=datetime.now)
    last_login: Optional[datetime] = None
    preferences: Dict[str, Any] = field(default_factory=dict)
    tags: List[str] = field(default_factory=list)

class UserManager:
    """Manages user profiles and operations."""
    
    def __init__(self):
        self.users: Dict[str, UserProfile] = {}
        self.config_path = Path("user_config.json")
        
    async def create_user(self, username: str, email: str) -> UserProfile:
        """Create a new user profile."""
        user_id = f"user_{len(self.users) + 1:04d}"
        
        if any(user.username == username for user in self.users.values()):
            raise ValueError(f"Username '{username}' already exists")
            
        user_profile = UserProfile(
            user_id=user_id,
            username=username,
            email=email
        )
        
        self.users[user_id] = user_profile
        logger.info(f"Created user: {username} with ID: {user_id}")
        
        await self._save_config()
        return user_profile
    
    async def get_user(self, user_id: str) -> Optional[UserProfile]:
        """Retrieve a user by ID."""
        return self.users.get(user_id)
    
    async def update_last_login(self, user_id: str) -> bool:
        """Update the last login timestamp for a user."""
        if user_id in self.users:
            self.users[user_id].last_login = datetime.now()
            await self._save_config()
            return True
        return False
    
    async def _save_config(self) -> None:
        """Save user configuration to file."""
        config_data = {
            user_id: {
                "username": user.username,
                "email": user.email,
                "created_at": user.created_at.isoformat(),
                "last_login": user.last_login.isoformat() if user.last_login else None,
                "preferences": user.preferences,
                "tags": user.tags
            }
            for user_id, user in self.users.items()
        }
        
        with open(self.config_path, 'w') as f:
            json.dump(config_data, f, indent=2)'''

            # Simulate the full response with tags
            full_response = f"Here's the updated code based on your requirements:\n\n<updated-code>\n{dummy_code}\n</updated-code>\n\nThe code has been successfully generated and includes proper error handling and async support."

            user_query = FILE_MODIFICATION_PROMPT.format(
                original_code=original_code, code_snippet=code_snippet
            )

            # Send model request event
            yield self._create_sse_event(
                "model_request",
                "Sending request to code generation model...",
                {
                    "model": "tgi_dummy",
                    "max_tokens": 20000,
                    "prompt_length": len(user_query),
                },
            )

            # Small delay to simulate network request
            await asyncio.sleep(0.1)

            # Send streaming start event
            yield self._create_sse_event(
                "model_streaming",
                "Receiving streamed response from model...",
                {"status": "streaming_started"},
            )

            # Stream the response in chunks
            chunk_size = 50  # Characters per chunk
            chunk_count = 0
            inside_code_block = False
            code_content = ""

            for i in range(0, len(full_response), chunk_size):
                chunk = full_response[i : i + chunk_size]
                chunk_count += 1

                # Small delay to simulate streaming
                await asyncio.sleep(0.05)

                # Check if we're entering or inside the code block
                if "<updated-code>" in chunk and not inside_code_block:
                    inside_code_block = True
                    yield self._create_sse_event(
                        "code_generation_start",
                        "Started generating updated code...",
                        {"chunk_count": chunk_count},
                    )
                    # Extract any code content after the tag
                    start_pos = chunk.find("<updated-code>") + len(
                        "<updated-code>"
                    )
                    if start_pos < len(chunk):
                        code_chunk = chunk[start_pos:]
                        if code_chunk.strip():
                            code_content += code_chunk
                            yield self._create_sse_event(
                                "code_chunk",
                                code_chunk,
                                {
                                    "chunk_number": chunk_count,
                                    "total_code_length": len(code_content),
                                    "is_inside_code_block": True,
                                },
                            )
                elif inside_code_block and "</updated-code>" not in chunk:
                    # We're inside the code block, stream the content
                    code_content += chunk
                    yield self._create_sse_event(
                        "code_chunk",
                        chunk,
                        {
                            "chunk_number": chunk_count,
                            "total_code_length": len(code_content),
                            "is_inside_code_block": True,
                        },
                    )
                elif inside_code_block and "</updated-code>" in chunk:
                    # We're reaching the end of the code block
                    end_pos = chunk.find("</updated-code>")
                    if end_pos > 0:
                        final_chunk = chunk[:end_pos]
                        code_content += final_chunk
                        yield self._create_sse_event(
                            "code_chunk",
                            final_chunk,
                            {
                                "chunk_number": chunk_count,
                                "total_code_length": len(code_content),
                                "is_inside_code_block": True,
                            },
                        )

                    inside_code_block = False
                    yield self._create_sse_event(
                        "code_generation_complete",
                        "Code generation completed",
                        {
                            "total_chunks": chunk_count,
                            "final_code_length": len(code_content),
                        },
                    )
                else:
                    # Stream non-code content for debugging/context
                    yield self._create_sse_event(
                        "model_output",
                        chunk,
                        {
                            "chunk_number": chunk_count,
                            "is_inside_code_block": False,
                        },
                    )

            # Process the complete response (same as original logic)
            final_edited_content = ""
            if (
                "<updated-code>" in full_response
                and "</updated-code>" in full_response
            ):
                start_tag = "<updated-code>"
                end_tag = "</updated-code>"
                start_pos = full_response.find(start_tag) + len(start_tag)
                end_pos = full_response.find(end_tag)
                final_edited_content = full_response[start_pos:end_pos].strip()
            else:
                final_edited_content = full_response.strip()

            # Validation
            if not isinstance(final_edited_content, str):
                raise ValueError("Edited content must be a string")

            if not final_edited_content:
                raise ValueError("Edited content cannot be empty")

            # Send completion event with final result
            yield self._create_sse_event(
                "completion",
                "File editing completed successfully",
                {
                    "success": True,
                    "final_content_length": len(final_edited_content),
                    "total_chunks_processed": chunk_count,
                    "edited_content": final_edited_content,
                    "timestamp": datetime.now().isoformat(),
                },
            )

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Dummy streaming error: {str(e)}",
                {
                    "stage": "dummy_model_streaming",
                    "timestamp": datetime.now().isoformat(),
                },
            )

    def _create_sse_event(
        self, event_type: str, content: str, metadata: dict = None
    ) -> str:
        """Create a server-sent event formatted string"""
        event_data = {
            "type": event_type,
            "content": content,
            "metadata": metadata or {},
            "timestamp": time.time(),
        }
        return f"data: {json.dumps(event_data)}\n\n"
