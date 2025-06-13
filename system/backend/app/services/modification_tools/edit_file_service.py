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

    async def edit_file(self, target_file_content: str, code_snippet: str):
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
        self, target_file_content: str, code_snippet: str
    ) -> AsyncGenerator[str, None]:
        """Stream the file editing process as server-sent events"""
        try:
            # Send model preparation event
            yield self._create_sse_event(
                "model_preparation",
                "Initializing model for code generation...",
                {
                    "model": "FastApply",
                    "stage": "model_init",
                    "explanation": None,
                },
            )

            async for event in self._apply_code_changes_stream(
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

            # Extract code from between tags with more robust parsing
            start_tag = "<updated-code>"
            end_tag = "</updated-code>"

            if start_tag in edited_content and end_tag in edited_content:
                start_pos = edited_content.find(start_tag) + len(start_tag)
                end_pos = edited_content.find(end_tag)
                if start_pos < end_pos:
                    edited_content = edited_content[start_pos:end_pos].strip()
                else:
                    raise ValueError("Invalid tag structure in model response")
            else:
                # Fallback: if tags are not found, return the content as is
                # This handles cases where the model doesn't use the expected tags
                edited_content = edited_content.strip()
                if not edited_content:
                    raise ValueError("No content found in model response")

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
                    "model": "FastApply",
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

            # Initialize state machine for tag detection
            content_buffer = ""
            chunk_count = 0
            code_content = ""

            # State machine variables
            inside_code_block = False

            # Start tag detection: <updated-code>
            start_tag_parts = ["<", "updated", "-code", ">"]
            start_tag_progress = 0
            start_tag_buffer = ""

            # End tag detection: </updated-code>
            end_tag_parts = ["</", "updated", "-code", ">"]
            end_tag_progress = 0
            end_tag_buffer = ""

            # Send streaming start event
            yield self._create_sse_event(
                "model_streaming",
                "Receiving streamed response from model...",
                {"status": "streaming_started"},
            )

            for message in chat_completion:
                content = message.choices[0].delta.content

                if content:
                    chunk_count += 1

                    if not inside_code_block:
                        # Looking for start tag
                        start_tag_buffer += content

                        # Check if we have a potential tag match
                        found_tag = False
                        for i in range(len(start_tag_parts)):
                            partial_tag = "".join(start_tag_parts[: i + 1])
                            if start_tag_buffer.endswith(partial_tag):
                                start_tag_progress = i + 1
                                if start_tag_progress == len(start_tag_parts):
                                    # Complete start tag detected!
                                    inside_code_block = True
                                    start_tag_progress = 0
                                    found_tag = True

                                    yield self._create_sse_event(
                                        "code_generation_start",
                                        "Started generating updated code...",
                                        {"chunk_count": chunk_count},
                                    )

                                    # Extract content after the tag
                                    tag_length = len("".join(start_tag_parts))
                                    remaining_content = start_tag_buffer[
                                        :-tag_length
                                    ]
                                    start_tag_buffer = start_tag_buffer[
                                        -tag_length:
                                    ]  # Keep only the tag

                                    # Stream any content before the tag
                                    if remaining_content:
                                        yield self._create_sse_event(
                                            "model_output",
                                            remaining_content,
                                            {
                                                "chunk_number": chunk_count,
                                                "is_inside_code_block": False,
                                            },
                                        )

                                    start_tag_buffer = ""
                                    break
                                else:
                                    # Partial tag match, keep buffering
                                    found_tag = True
                                    break

                        if not found_tag:
                            # No tag match, check if buffer might contain start of a tag
                            potential_tag_start = False
                            for part in start_tag_parts:
                                if (
                                    part.startswith(
                                        start_tag_buffer[-len(part) :]
                                    )
                                    if len(start_tag_buffer) <= len(part)
                                    else start_tag_buffer.endswith(
                                        part[: len(start_tag_buffer)]
                                    )
                                ):
                                    potential_tag_start = True
                                    break

                            if not potential_tag_start and len(
                                start_tag_buffer
                            ) > len(max(start_tag_parts, key=len)):
                                # Buffer is too long and no potential tag, stream most of it
                                content_to_stream = start_tag_buffer[
                                    : -len(max(start_tag_parts, key=len))
                                ]
                                start_tag_buffer = start_tag_buffer[
                                    -len(max(start_tag_parts, key=len)) :
                                ]

                                yield self._create_sse_event(
                                    "model_output",
                                    content_to_stream,
                                    {
                                        "chunk_number": chunk_count,
                                        "is_inside_code_block": False,
                                    },
                                )

                    else:
                        # Inside code block, looking for end tag
                        end_tag_buffer += content

                        # Check if we have a potential end tag match
                        found_end_tag = False
                        for i in range(len(end_tag_parts)):
                            partial_tag = "".join(end_tag_parts[: i + 1])
                            if end_tag_buffer.endswith(partial_tag):
                                end_tag_progress = i + 1
                                if end_tag_progress == len(end_tag_parts):
                                    # Complete end tag detected!
                                    inside_code_block = False
                                    end_tag_progress = 0
                                    found_end_tag = True

                                    # Extract content before the tag
                                    tag_length = len("".join(end_tag_parts))
                                    code_chunk = end_tag_buffer[:-tag_length]

                                    # Stream the code content
                                    if code_chunk:
                                        code_content += code_chunk
                                        yield self._create_sse_event(
                                            "code_chunk",
                                            code_chunk,
                                            {
                                                "chunk_number": chunk_count,
                                                "total_code_length": len(
                                                    code_content
                                                ),
                                                "is_inside_code_block": True,
                                            },
                                        )

                                    yield self._create_sse_event(
                                        "code_generation_complete",
                                        "Code generation completed",
                                        {
                                            "total_chunks": chunk_count,
                                            "final_code_length": len(
                                                code_content
                                            ),
                                        },
                                    )

                                    end_tag_buffer = ""
                                    break
                                else:
                                    # Partial end tag match, keep buffering
                                    found_end_tag = True
                                    break

                        if not found_end_tag:
                            # No end tag match, check if buffer might contain start of end tag
                            potential_end_tag_start = False
                            for part in end_tag_parts:
                                if (
                                    part.startswith(
                                        end_tag_buffer[-len(part) :]
                                    )
                                    if len(end_tag_buffer) <= len(part)
                                    else end_tag_buffer.endswith(
                                        part[: len(end_tag_buffer)]
                                    )
                                ):
                                    potential_end_tag_start = True
                                    break

                            if not potential_end_tag_start and len(
                                end_tag_buffer
                            ) > len(max(end_tag_parts, key=len)):
                                # Buffer is too long and no potential end tag, stream most of it as code
                                content_to_stream = end_tag_buffer[
                                    : -len(max(end_tag_parts, key=len))
                                ]
                                end_tag_buffer = end_tag_buffer[
                                    -len(max(end_tag_parts, key=len)) :
                                ]

                                code_content += content_to_stream
                                yield self._create_sse_event(
                                    "code_chunk",
                                    content_to_stream,
                                    {
                                        "chunk_number": chunk_count,
                                        "total_code_length": len(code_content),
                                        "is_inside_code_block": True,
                                    },
                                )

            # Final processing
            final_edited_content = code_content.strip()

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
