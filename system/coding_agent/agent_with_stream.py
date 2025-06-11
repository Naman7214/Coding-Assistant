import json
import os
import time
from datetime import datetime
from logging import getLogger
from typing import Any, AsyncGenerator, Dict, List, Optional

from models.schema.context_schema import RecentEditsContext

import httpx
from config.settings import settings
from fastmcp import Client
from memory.agent_memory import AgentMemory
from motor.motor_asyncio import AsyncIOMotorClient
from prompts.coding_agent_prompt import CODING_AGENT_SYSTEM_PROMPT
from utils.context_formatter import (
    format_active_file_context,
    format_additional_context,
    format_open_files_context,
    format_recent_edits_context,
    format_system_info_context,
)

logger = getLogger(__name__)


class AnthropicStreamingAgent:
    MAX_TOOL_CALL_DEPTH = 50  # Prevent infinite recursion
    MAX_RETRIES = 3

    def __init__(self, model_name="claude-sonnet-4-20250514"):
        self.model_name = model_name
        self.agent_memory = AgentMemory()
        self.client = None
        self.anthropic_tools = []
        self.workspace_path = None
        self.system_info = None
        self.active_file_context = None  # New: store active file context
        self.open_files_context = []  # New: store open files context
        self.recent_edits_context = None  # New: store recent edits context
        self.additional_context = {}  # New: store on-demand context
        self.timeout = httpx.Timeout(
            connect=60.0,
            read=300.0,
            write=120.0,
            pool=60.0,
        )

        try:
            self.mongodb_client = AsyncIOMotorClient(settings.MONGODB_URL)
            self.llm_usage_collection = self.mongodb_client[
                settings.MONGODB_DB_NAME
            ][settings.LLM_USAGE_COLLECTION_NAME]
        except Exception as e:
            logger.error(f"MongoDB connection error: {str(e)}")
            self.mongodb_client = None
            self.llm_usage_collection = None

    def set_system_info(self, system_info: dict):
        """Set system information for the agent"""
        self.system_info = system_info
        logger.info(
            f"System info updated: {system_info.get('platform', 'unknown')} {system_info.get('osVersion', '')}"
        )

    def set_active_file_context(self, active_file_context: Optional[dict]):
        """Set active file context (always-send context)"""
        self.active_file_context = active_file_context
        if active_file_context:
            logger.info(
                f"Active file context updated: {active_file_context.get('file', 'unknown')}"
            )
        else:
            logger.info("Active file context cleared")

    def set_open_files_context(self, open_files_context: Optional[list]):
        """Set open files context (always-send context)"""
        self.open_files_context = open_files_context or []
        logger.info(
            f"Open files context updated: {len(self.open_files_context)} files"
        )

    def set_recent_edits_context(self, recent_edits_context: Optional[RecentEditsContext]):
        """Set recent edits context (always-send context)"""
        self.recent_edits_context = recent_edits_context
        if recent_edits_context:
            summary = recent_edits_context.summary
            if summary.hasChanges:
                total_files = summary.totalFiles
                logger.info(
                    f"Recent edits context updated: {total_files} files changed in last 3 minutes"
                )
            else:
                logger.info("Recent edits context updated: No recent changes")
        else:
            logger.info("Recent edits context cleared")

    async def update_context_memory(
        self,
        system_info: Optional[dict] = None,
        active_file: Optional[dict] = None,
        open_files: Optional[list] = None,
        recent_edits: Optional[RecentEditsContext] = None,
        additional_context: Optional[dict] = None,
    ):
        """Update agent memory with enhanced context information"""
        try:
            # Update internal context storage
            if system_info:
                self.system_info = system_info
            if active_file is not None:  # Explicit None check to allow clearing
                self.active_file_context = active_file
            if open_files is not None:  # Explicit None check to allow clearing
                self.open_files_context = open_files
            if (
                recent_edits is not None
            ):  # Explicit None check to allow clearing
                self.recent_edits_context = recent_edits
            if additional_context:
                self.additional_context.update(additional_context)

            # Create enhanced system prompt with all context
            enhanced_system_prompt = await self._create_enhanced_system_prompt()

            # Update agent memory with enhanced system prompt
            self.agent_memory.initialize_with_system_message(
                enhanced_system_prompt
            )

            logger.info("✅ Agent memory updated with enhanced context")

        except Exception as e:
            logger.error(f"Failed to update context memory: {e}")
            # Continue with basic operation even if context update fails

    async def _create_enhanced_system_prompt(self) -> str:
        """Create enhanced system prompt with all available context"""
        try:
            # Start with base system prompt
            from prompts.coding_agent_prompt import CODING_AGENT_SYSTEM_PROMPT

            # Format system info context
            system_info_context = format_system_info_context(
                system_info=self.system_info
            )
            base_prompt = CODING_AGENT_SYSTEM_PROMPT.format(
                system_info_context=system_info_context
            )

            # Add always-send context sections
            enhanced_prompt = base_prompt + "\n\n"

            # Add active file context if available
            if self.active_file_context:
                enhanced_prompt += format_active_file_context(
                    active_file_context=self.active_file_context
                )

            # Add open files context if available
            if self.open_files_context:
                enhanced_prompt += format_open_files_context(
                    open_files_context=self.open_files_context
                )

            # Add recent edits context if available
            if self.recent_edits_context:
                enhanced_prompt += format_recent_edits_context(
                    recent_edits_context=self.recent_edits_context
                )

            # Add on-demand context sections
            if self.additional_context:
                enhanced_prompt += format_additional_context(
                    additional_context=self.additional_context
                )

            return enhanced_prompt

        except Exception as e:
            logger.error(f"Failed to create enhanced system prompt: {str(e)}")
            # Fallback to basic prompt
            return CODING_AGENT_SYSTEM_PROMPT.format(
                system_info_context=format_system_info_context(
                    system_info=self.system_info
                )
            )

    async def anthropic_streaming_api_call(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        **params,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Call the Anthropic API with streaming enabled"""
        url = settings.ANTHROPIC_BASE_URL

        headers = {
            "x-api-key": settings.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "anthropic-beta": "interleaved-thinking-2025-05-14",
        }

        # Convert OpenAI tool format to Anthropic tool format
        anthropic_tools = []
        for tool in tools:
            if tool.get("type") == "function":
                function_info = tool.get("function", {})
                anthropic_tools.append(
                    {
                        "name": function_info.get("name", ""),
                        "description": function_info.get("description", ""),
                        "input_schema": function_info.get("parameters", {}),
                    }
                )

        # Extract system message if present
        system_content = None
        for message in messages:
            if message.get("role") == "system":
                system_content = message.get("content")
                if isinstance(system_content, str):
                    # If it's a string, it's already in the correct format
                    pass
                elif isinstance(system_content, list):
                    # If content is a list of blocks, extract text from text blocks
                    system_text = ""
                    for block in system_content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "text"
                        ):
                            system_text += block.get("text", "")
                    system_content = system_text
                break

        print(f"System content: {system_content}")

        # Prepare normal messages, skipping system message
        anthropic_messages = []
        for message in messages:
            if message.get("role") != "system":
                anthropic_messages.append(message)

        payload = {
            "model": self.model_name,
            "max_tokens": params.get("max_tokens", 3000),
            "tools": anthropic_tools,
            "messages": anthropic_messages,
            "thinking": {"type": "enabled", "budget_tokens": 2500},
            "stream": True,  # Enable streaming
            # "temperature": 0,
        }

        # Add system parameter if we have a system message
        if system_content:
            payload["system"] = system_content

        # Debug: Print payload structure (remove in production)
        logger.info(
            f"Sending request with {len(anthropic_messages)} messages and {len(anthropic_tools)} tools"
        )

        try:
            start_time = time.time()

            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                async with client.stream(
                    "POST", url=url, headers=headers, json=payload
                ) as response:
                    try:
                        response.raise_for_status()

                        # Variables to accumulate the complete response for logging
                        complete_message = {
                            "id": None,
                            "type": "message",
                            "role": "assistant",
                            "content": [],
                            "model": self.model_name,
                            "stop_reason": None,
                            "stop_sequence": None,
                            "usage": {},
                        }

                        current_content_blocks = {}

                        async for line in response.aiter_lines():
                            if line.startswith("data: "):
                                try:
                                    data = json.loads(
                                        line[6:]
                                    )  # Remove "data: " prefix

                                    # Handle different event types
                                    event_type = data.get("type")

                                    if event_type == "message_start":
                                        message_data = data.get("message", {})
                                        complete_message.update(message_data)
                                        yield {
                                            "type": "message_start",
                                            "data": data,
                                        }

                                    elif event_type == "content_block_start":
                                        index = data.get("index", 0)
                                        content_block = data.get(
                                            "content_block", {}
                                        )
                                        logger.debug(
                                            f"Starting content block {index}: {content_block.get('type', 'unknown')} - {content_block.get('name', 'N/A')}"
                                        )
                                        current_content_blocks[index] = (
                                            content_block.copy()
                                        )
                                        yield {
                                            "type": "content_block_start",
                                            "data": data,
                                        }

                                    elif event_type == "content_block_delta":
                                        index = data.get("index", 0)
                                        delta = data.get("delta", {})

                                        # Update the current content block with delta
                                        if index in current_content_blocks:
                                            if (
                                                delta.get("type")
                                                == "thinking_delta"
                                            ):
                                                if (
                                                    "thinking"
                                                    not in current_content_blocks[
                                                        index
                                                    ]
                                                ):
                                                    current_content_blocks[
                                                        index
                                                    ]["thinking"] = ""
                                                current_content_blocks[index][
                                                    "thinking"
                                                ] += delta.get("thinking", "")
                                            elif (
                                                delta.get("type")
                                                == "signature_delta"
                                            ):
                                                # Handle signature deltas - these ARE needed for thinking blocks
                                                logger.debug(
                                                    "Received signature_delta (preserving for thinking block)"
                                                )
                                                if (
                                                    "signature"
                                                    not in current_content_blocks[
                                                        index
                                                    ]
                                                ):
                                                    current_content_blocks[
                                                        index
                                                    ]["signature"] = ""
                                                current_content_blocks[index][
                                                    "signature"
                                                ] += delta.get("signature", "")
                                            elif (
                                                delta.get("type")
                                                == "text_delta"
                                            ):
                                                if (
                                                    "text"
                                                    not in current_content_blocks[
                                                        index
                                                    ]
                                                ):
                                                    current_content_blocks[
                                                        index
                                                    ]["text"] = ""
                                                current_content_blocks[index][
                                                    "text"
                                                ] += delta.get("text", "")
                                            elif (
                                                delta.get("type")
                                                == "input_json_delta"
                                            ):
                                                # Handle tool_use input deltas
                                                logger.debug(
                                                    f"Received input_json_delta: {delta.get('partial_json', '')}"
                                                )

                                                # Always accumulate in partial_json for final parsing
                                                if (
                                                    "partial_json"
                                                    not in current_content_blocks[
                                                        index
                                                    ]
                                                ):
                                                    current_content_blocks[
                                                        index
                                                    ]["partial_json"] = ""
                                                current_content_blocks[index][
                                                    "partial_json"
                                                ] += delta.get(
                                                    "partial_json", ""
                                                )
                                                logger.debug(
                                                    f"Accumulated partial JSON: {current_content_blocks[index]['partial_json']}"
                                                )

                                                # Try to parse if it looks like complete JSON (optional, for real-time updates)
                                                try:
                                                    if (
                                                        current_content_blocks[
                                                            index
                                                        ]["partial_json"]
                                                        .strip()
                                                        .endswith("}")
                                                    ):
                                                        test_parse = json.loads(
                                                            current_content_blocks[
                                                                index
                                                            ][
                                                                "partial_json"
                                                            ]
                                                        )
                                                        current_content_blocks[
                                                            index
                                                        ]["input"] = test_parse
                                                        logger.debug(
                                                            "Successfully parsed intermediate input"
                                                        )
                                                except json.JSONDecodeError:
                                                    # Not complete yet, continue accumulating
                                                    pass

                                        yield {
                                            "type": "content_block_delta",
                                            "data": data,
                                        }

                                    elif event_type == "content_block_stop":
                                        index = data.get("index", 0)
                                        if index in current_content_blocks:
                                            # Clean up content blocks before adding to complete message
                                            content_block = (
                                                current_content_blocks[
                                                    index
                                                ].copy()
                                            )

                                            # For thinking blocks, preserve all fields including signature
                                            if (
                                                content_block.get("type")
                                                == "thinking"
                                            ):
                                                logger.debug(
                                                    "Preserving thinking block with signature"
                                                )
                                                # Keep the thinking block as-is, including signature if present
                                                if "signature" in content_block:
                                                    logger.debug(
                                                        f"Thinking block has signature (length: {len(content_block['signature'])})"
                                                    )
                                                else:
                                                    logger.warning(
                                                        "Thinking block missing signature!"
                                                    )

                                            # For tool_use blocks, ensure input is properly reconstructed
                                            elif (
                                                content_block.get("type")
                                                == "tool_use"
                                            ):
                                                logger.debug(
                                                    f"Finalizing tool_use block: {content_block.get('name', 'unknown')}"
                                                )
                                                # If we have partial_json, try to parse it as the final input
                                                if (
                                                    "partial_json"
                                                    in content_block
                                                ):
                                                    logger.debug(
                                                        f"Parsing final partial_json: {content_block['partial_json']}"
                                                    )
                                                    try:
                                                        # Strip whitespace and validate JSON
                                                        json_str = (
                                                            content_block[
                                                                "partial_json"
                                                            ].strip()
                                                        )
                                                        if json_str:
                                                            parsed_input = (
                                                                json.loads(
                                                                    json_str
                                                                )
                                                            )
                                                            content_block[
                                                                "input"
                                                            ] = parsed_input
                                                            del content_block[
                                                                "partial_json"
                                                            ]  # Clean up
                                                            logger.debug(
                                                                "Successfully parsed final input"
                                                            )
                                                        else:
                                                            logger.warning(
                                                                f"Empty JSON string for tool {content_block.get('name', 'unknown')}"
                                                            )
                                                            content_block[
                                                                "input"
                                                            ] = {}
                                                            del content_block[
                                                                "partial_json"
                                                            ]
                                                    except (
                                                        json.JSONDecodeError
                                                    ) as e:
                                                        logger.error(
                                                            f"Failed to parse tool input JSON for tool {content_block.get('name', 'unknown')}: {str(e)}"
                                                        )
                                                        logger.error(
                                                            f"Partial JSON was: {content_block['partial_json']}"
                                                        )
                                                        # Set empty input and clean up
                                                        content_block[
                                                            "input"
                                                        ] = {}
                                                        del content_block[
                                                            "partial_json"
                                                        ]
                                                else:
                                                    logger.debug(
                                                        "Tool already has input"
                                                    )

                                            complete_message["content"].append(
                                                content_block
                                            )
                                        yield {
                                            "type": "content_block_stop",
                                            "data": data,
                                        }

                                    elif event_type == "message_delta":
                                        delta = data.get("delta", {})
                                        complete_message.update(delta)
                                        yield {
                                            "type": "message_delta",
                                            "data": data,
                                        }

                                    elif event_type == "message_stop":

                                        # Calculate API call duration
                                        duration = time.time() - start_time

                                        # Log API usage to MongoDB
                                        if (
                                            self.mongodb_client is not None
                                            and self.llm_usage_collection
                                            is not None
                                        ):
                                            try:
                                                # Extract usage information
                                                usage = complete_message.get(
                                                    "usage", {}
                                                )
                                                input_tokens = usage.get(
                                                    "input_tokens", 0
                                                )
                                                output_tokens = usage.get(
                                                    "output_tokens", 0
                                                )
                                                cache_creation_input_tokens = usage.get(
                                                    "cache_creation_input_tokens",
                                                    0,
                                                )
                                                cache_read_input_tokens = usage.get(
                                                    "cache_read_input_tokens", 0
                                                )

                                                total_tokens = (
                                                    input_tokens
                                                    + output_tokens
                                                    + cache_creation_input_tokens
                                                    + cache_read_input_tokens
                                                )

                                                # Create usage log document
                                                llm_usage = {
                                                    "input_tokens": input_tokens,
                                                    "output_tokens": output_tokens,
                                                    "total_tokens": total_tokens,
                                                    "cache_creation_input_tokens": cache_creation_input_tokens,
                                                    "cache_read_input_tokens": cache_read_input_tokens,
                                                    "duration": duration,
                                                    "provider": "Anthropic",
                                                    "model": self.model_name,
                                                    "created_at": datetime.utcnow(),
                                                    "request_id": complete_message.get(
                                                        "id", "unknown"
                                                    ),
                                                    "request_type": "chat_streaming",
                                                }

                                                # Log asynchronously without waiting for completion
                                                await self.llm_usage_collection.insert_one(
                                                    llm_usage
                                                )
                                            except Exception as log_error:
                                                logger.warning(
                                                    f"Failed to log API usage: {str(log_error)}"
                                                )

                                        yield {
                                            "type": "message_stop",
                                            "data": data,
                                            "complete_message": complete_message,
                                        }

                                    else:
                                        # Handle any other event types
                                        yield {"type": event_type, "data": data}

                                except json.JSONDecodeError as e:
                                    logger.warning(
                                        f"Failed to parse JSON line: {line}"
                                    )
                                    logger.warning(f"JSON decode error: {e}")
                                    # Skip malformed JSON lines
                                    continue
                            elif line.startswith("event: "):
                                # Event type line, we can ignore this as the type is in the data
                                continue
                            elif line.strip() == "":
                                # Empty line, continue
                                continue
                            else:
                                logger.warning(
                                    f"Unexpected line format: {line}"
                                )

                    except httpx.HTTPStatusError as e:
                        # For streaming responses, we can't access response.text directly
                        # Try to read the response content if possible, otherwise just use the status
                        try:
                            error_content = await response.aread()
                            error_text = (
                                error_content.decode("utf-8")
                                if error_content
                                else "No error details available"
                            )
                        except:
                            error_text = f"HTTP {e.response.status_code} error"

                        logger.error(
                            f"Error in Anthropic Streaming API: {error_text} - {str(e)}"
                        )
                        yield {
                            "type": "error",
                            "data": {"error": str(e), "details": error_text},
                        }

        except httpx.RequestError as e:
            logger.error(
                f"Request Error in Anthropic Streaming API call: {str(e)}"
            )
            yield {"type": "error", "data": {"error": str(e)}}
        except httpx.HTTPError as e:
            logger.error(
                f"Error in Anthropic Streaming API call HTTPError: {str(e)}"
            )
            yield {"type": "error", "data": {"error": str(e)}}
        except Exception as e:
            logger.error(f"Error in Anthropic Streaming API call: {str(e)}")
            yield {"type": "error", "data": {"error": str(e)}}

    async def initialize_session(
        self, server_url, transport_type, workspace_path, system_info=None
    ):
        """Initialize the MCP session with optional system information and workspace ID"""
        try:
            # Store workspace path, system info, and workspace ID
            self.workspace_path = workspace_path or os.getcwd()
            if system_info:
                self.set_system_info(system_info)

            logger.info(
                f"Initializing session with workspace: {self.workspace_path}"
            )

            # Clean up any existing session first
            await self.cleanup()

            # Connect to MCP server using FastMCP
            logger.info(f"Connecting to FastMCP server via {transport_type}...")
            try:
                # Create a FastMCP client
                if transport_type.lower() == "sse":
                    # Use SSE transport with the server URL
                    self.client = Client(server_url)
                else:  # stdio
                    # Use stdio transport with the server path
                    self.client = Client(server_url)

                # Enter the client context
                await self.client.__aenter__()

                logger.info("✓ Connected to FastMCP server successfully!")

                # Get available tools
                logger.info("Loading available tools...")
                tools = await self.client.list_tools()

                if not tools:
                    logger.error("No tools available from the FastMCP server.")
                    return False

                # Log available tools
                logger.info(f"Found {len(tools)} available tools:")
                for tool in tools:
                    logger.info(f"  - {tool.name}: {tool.description}")

                # Convert FastMCP tools to Anthropic format
                self.anthropic_tools = []
                for tool in tools:
                    self.anthropic_tools.append(
                        {
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.inputSchema,
                            },
                        }
                    )

                # Format system info context
                system_info_context = format_system_info_context(
                    system_info=self.system_info
                )

                # Use the actual workspace path and system info
                system_message = CODING_AGENT_SYSTEM_PROMPT.format(
                    system_info_context=system_info_context,
                )

                # Initialize agent memory with system message
                logger.info(
                    "Initializing agent system prompt with system information and workspace context"
                )
                self.agent_memory.initialize_with_system_message(system_message)
                return True

            except Exception as e:
                logger.error(f"Error connecting to FastMCP server: {str(e)}")
                return False

        except Exception as e:
            logger.error(f"Error initializing session: {str(e)}")
            return False

    async def cleanup(self):
        """Clean up resources before exiting"""
        try:
            if self.client:
                try:
                    await self.client.__aexit__(None, None, None)
                    logger.info("FastMCP client closed successfully")
                except Exception as e:
                    logger.error(f"Error closing FastMCP client: {str(e)}")
        except Exception as e:
            logger.error(f"Error during cleanup: {str(e)}")


if __name__ == "__main__":
    pass
