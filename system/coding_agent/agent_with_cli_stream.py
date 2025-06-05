import asyncio
import json
import os
import sys
import time
import uuid
from datetime import datetime
from logging import getLogger
from typing import Any, Dict, List, AsyncGenerator, Optional

import httpx
from config.settings import settings
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from memory.agent_memory import AgentMemory
from motor.motor_asyncio import AsyncIOMotorClient
from prompts.coding_agent_prompt import CODING_AGENT_SYSTEM_PROMPT
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.syntax import Syntax
from rich.table import Table
from rich.theme import Theme

from context.http_context_adapter import ContextRetriever

logger = getLogger(__name__)


# Custom Rich theme
custom_theme = Theme(
    {
        "info": "cyan",
        "warning": "yellow",
        "error": "bold red",
        "success": "bold green",
        "tool": "bold magenta",
        "user": "bold blue",
        "assistant": "green",
        "tool_result": "dim white",
        "thinking": "yellow",
    }
)

# Create console with custom theme
console = Console(theme=custom_theme)


class AnthropicStreamingAgent:
    MAX_TOOL_CALL_DEPTH = 50  # Prevent infinite recursion
    MAX_RETRIES = 3

    def __init__(self, model_name="claude-sonnet-4-20250514"):
        self.model_name = model_name
        self.agent_memory = AgentMemory()
        self.session = None
        self.client_context = None
        self.anthropic_tools = []
        self.workspace_path = None
        self.workspace_id = None  # Add workspace_id property
        self.system_info = None  # Add system info storage
        self.context_retriever = ContextRetriever()  # Initialize with default path
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
            console.print(f"[error]MongoDB connection error: {str(e)}[/error]")
            self.mongodb_client = None
            self.llm_usage_collection = None

    def set_system_info(self, system_info: dict):
        """Set system information for the agent"""
        self.system_info = system_info
        console.print(f"[info]System info updated: {system_info.get('platform', 'unknown')} {system_info.get('osVersion', '')}[/info]")

    def set_workspace_id(self, workspace_id: str):
        """Set workspace ID for context retrieval"""
        self.workspace_id = workspace_id
        console.print(f"[info]Workspace ID set: {workspace_id}[/info]")

    def _format_system_info_context(self) -> str:
        """Format system information for the prompt"""
        if not self.system_info:
            return "No system information available."
        
        context = f"""
SYSTEM INFORMATION:
- Platform: {self.system_info.get('platform', 'unknown')}
- OS Version: {self.system_info.get('osVersion', 'unknown')}
- Architecture: {self.system_info.get('architecture', 'unknown')}
- Workspace Path: {self.system_info.get('workspacePath', 'unknown')}
- Workspace Name: {self.system_info.get('workspaceName', 'N/A')}
- Default Shell: {self.system_info.get('defaultShell', 'unknown')}
"""
        return context

    async def get_workspace_context(self) -> Optional[str]:
        """Retrieve workspace context using the workspace ID"""
        if not self.workspace_id:
            console.print("[warning]No workspace ID available for context retrieval[/warning]")
            return None

        try:
            # Get workspace context from SQLite database
            workspace_context = self.context_retriever.get_workspace_context(self.workspace_id)
            
            if workspace_context:
                console.print(f"[success]Retrieved workspace context from {workspace_context['source']}[/success]")
                console.print(f"[info]Context contains {workspace_context['token_count']} tokens[/info]")
                
                console.print(f"[info]Workspace Context:\n{workspace_context}[/info]")
                
                # Format context for the agent
                return self._format_workspace_context_for_agent(workspace_context)
            else:
                console.print("[warning]No workspace context available[/warning]")
                return None
                
        except Exception as e:
            console.print(f"[error]Failed to retrieve workspace context: {e}[/error]")
            return None

    def _format_workspace_context_for_agent(self, workspace_context: Dict[str, Any]) -> str:
        """Format workspace context for inclusion in agent memory"""
        try:
            workspace_info = workspace_context.get('workspace_info', {})
            context_data = workspace_context.get('context_data', {})
            
            # Build formatted context string
            formatted_context = f"""
=== WORKSPACE CONTEXT ===
Workspace: {workspace_info.get('name', 'Unknown')} ({workspace_info.get('path', 'Unknown')})
Source: {workspace_context.get('source', 'unknown')}
Token Count: {workspace_context.get('token_count', 0)}

"""
            
            # Add workspace summary if available
            if 'summary' in context_data:
                summary = context_data['summary']
                formatted_context += f"""
FILES & STRUCTURE:
- Total Files: {summary.get('total_files', 0)}
- Languages: {', '.join(summary.get('languages', []))}
- Most Accessed Files: {len(summary.get('most_accessed_files', []))} files tracked

"""
            
            # Add recent files if available
            files = context_data.get('files', [])
            if files:
                formatted_context += f"""
RECENT FILES (Top 10):
"""
                for i, file_info in enumerate(files[:10]):
                    formatted_context += f"  {i+1}. {file_info.get('relative_path', 'Unknown')} ({file_info.get('language_id', 'Unknown')})\n"
                
                if len(files) > 10:
                    formatted_context += f"  ... and {len(files) - 10} more files\n"
            
            # Add full context data if from cached session
            if workspace_context.get('source') == 'cached_session' and 'activeFile' in context_data:
                active_file = context_data.get('activeFile')
                if active_file:
                    formatted_context += f"""
ACTIVE FILE:
- Path: {active_file.get('relativePath', 'Unknown')}
- Language: {active_file.get('languageId', 'Unknown')}
- Lines: {active_file.get('lineCount', 0)}
- Dirty: {active_file.get('isDirty', False)}

"""
                
                # Add git context if available
                git_context = context_data.get('gitContext', {})
                if git_context.get('isRepo'):
                    formatted_context += f"""
GIT CONTEXT:
- Branch: {git_context.get('branch', 'Unknown')}
- Has Changes: {git_context.get('hasChanges', False)}
- Changed Files: {len(git_context.get('changedFiles', []))}
- Recent Commits: {len(git_context.get('recentCommits', []))}

"""
            
            formatted_context += "=== END WORKSPACE CONTEXT ===\n"
            return formatted_context
            
        except Exception as e:
            console.print(f"[error]Failed to format workspace context: {e}[/error]")
            return f"Error formatting workspace context: {e}"

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
            "anthropic-beta": "interleaved-thinking-2025-05-14"
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
        console.print(f"[info]Sending request with {len(anthropic_messages)} messages and {len(anthropic_tools)} tools[/info]")

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
                            "usage": {}
                        }
                        
                        current_content_blocks = {}
                        
                        async for line in response.aiter_lines():
                            if line.startswith("data: "):
                                try:
                                    data = json.loads(line[6:])  # Remove "data: " prefix
                                    
                                    # Handle different event types
                                    event_type = data.get("type")
                                    
                                    if event_type == "message_start":
                                        message_data = data.get("message", {})
                                        complete_message.update(message_data)
                                        yield {"type": "message_start", "data": data}
                                    
                                    elif event_type == "content_block_start":
                                        index = data.get("index", 0)
                                        content_block = data.get("content_block", {})
                                        console.print(f"[info]DEBUG: Starting content block {index}: {content_block.get('type', 'unknown')} - {content_block.get('name', 'N/A')}[/info]")
                                        current_content_blocks[index] = content_block.copy()
                                        yield {"type": "content_block_start", "data": data}
                                    
                                    elif event_type == "content_block_delta":
                                        index = data.get("index", 0)
                                        delta = data.get("delta", {})
                                        
                                        # Update the current content block with delta
                                        if index in current_content_blocks:
                                            if delta.get("type") == "thinking_delta":
                                                if "thinking" not in current_content_blocks[index]:
                                                    current_content_blocks[index]["thinking"] = ""
                                                current_content_blocks[index]["thinking"] += delta.get("thinking", "")
                                            elif delta.get("type") == "signature_delta":
                                                # Handle signature deltas - these ARE needed for thinking blocks
                                                console.print(f"[info]DEBUG: Received signature_delta (preserving for thinking block)[/info]")
                                                if "signature" not in current_content_blocks[index]:
                                                    current_content_blocks[index]["signature"] = ""
                                                current_content_blocks[index]["signature"] += delta.get("signature", "")
                                            elif delta.get("type") == "text_delta":
                                                if "text" not in current_content_blocks[index]:
                                                    current_content_blocks[index]["text"] = ""
                                                current_content_blocks[index]["text"] += delta.get("text", "")
                                            elif delta.get("type") == "input_json_delta":
                                                # Handle tool_use input deltas
                                                console.print(f"[info]DEBUG: Received input_json_delta: {delta.get('partial_json', '')}[/info]", markup=False)
                                                
                                                # Always accumulate in partial_json for final parsing
                                                if "partial_json" not in current_content_blocks[index]:
                                                    current_content_blocks[index]["partial_json"] = ""
                                                current_content_blocks[index]["partial_json"] += delta.get("partial_json", "")
                                                console.print(f"[info]DEBUG: Accumulated partial JSON: {current_content_blocks[index]['partial_json']}[/info]", markup=False)
                                                
                                                # Try to parse if it looks like complete JSON (optional, for real-time updates)
                                                try:
                                                    if current_content_blocks[index]["partial_json"].strip().endswith("}"):
                                                        test_parse = json.loads(current_content_blocks[index]["partial_json"])
                                                        current_content_blocks[index]["input"] = test_parse
                                                        console.print(f"[info]DEBUG: Successfully parsed intermediate input:[/info]")
                                                        console.print(json.dumps(current_content_blocks[index]['input'], indent=2), markup=False)
                                                except json.JSONDecodeError:
                                                    # Not complete yet, continue accumulating
                                                    pass
                                        
                                        yield {"type": "content_block_delta", "data": data}
                                    
                                    elif event_type == "content_block_stop":
                                        index = data.get("index", 0)
                                        if index in current_content_blocks:
                                            # Clean up content blocks before adding to complete message
                                            content_block = current_content_blocks[index].copy()
                                            
                                            # For thinking blocks, preserve all fields including signature
                                            if content_block.get("type") == "thinking":
                                                console.print(f"[info]DEBUG: Preserving thinking block with signature[/info]")
                                                # Keep the thinking block as-is, including signature if present
                                                if "signature" in content_block:
                                                    console.print(f"[info]DEBUG: Thinking block has signature (length: {len(content_block['signature'])})[/info]")
                                                else:
                                                    console.print(f"[warning]DEBUG: Thinking block missing signature![/warning]")
                                            
                                            # For tool_use blocks, ensure input is properly reconstructed
                                            elif content_block.get("type") == "tool_use":
                                                console.print(f"[info]DEBUG: Finalizing tool_use block: {content_block.get('name', 'unknown')}[/info]")
                                                # If we have partial_json, try to parse it as the final input
                                                if "partial_json" in content_block:
                                                    console.print(f"[info]DEBUG: Parsing final partial_json: {content_block['partial_json']}[/info]", markup=False)
                                                    try:
                                                        # Strip whitespace and validate JSON
                                                        json_str = content_block["partial_json"].strip()
                                                        if json_str:
                                                            parsed_input = json.loads(json_str)
                                                            content_block["input"] = parsed_input
                                                            del content_block["partial_json"]  # Clean up
                                                            console.print(f"[info]DEBUG: Successfully parsed final input:[/info]")
                                                            console.print(json.dumps(content_block['input'], indent=2), markup=False)
                                                        else:
                                                            console.print(f"[warning]Empty JSON string for tool {content_block.get('name', 'unknown')}[/warning]")
                                                            content_block["input"] = {}
                                                            del content_block["partial_json"]
                                                    except json.JSONDecodeError as e:
                                                        console.print(f"[error]Failed to parse tool input JSON for tool {content_block.get('name', 'unknown')}: {str(e)}[/error]")
                                                        console.print(f"[error]Partial JSON was: {content_block['partial_json']}[/error]", markup=False)
                                                        # Set empty input and clean up
                                                        content_block["input"] = {}
                                                        del content_block["partial_json"]
                                                else:
                                                    console.print(f"[info]DEBUG: Tool already has input:[/info]")
                                                    console.print(json.dumps(content_block.get('input', {}), indent=2), markup=False)
                                            
                                            complete_message["content"].append(content_block)
                                        yield {"type": "content_block_stop", "data": data}
                                    
                                    elif event_type == "message_delta":
                                        delta = data.get("delta", {})
                                        complete_message.update(delta)
                                        yield {"type": "message_delta", "data": data}
                                    
                                    elif event_type == "message_stop":
                                        # The JSON parsing and validation already happens in content_block_stop
                                        # No need to check current_content_blocks here as it contains the original
                                        # blocks with partial_json, while complete_message["content"] has the cleaned blocks
                                        
                                        # Calculate API call duration
                                        duration = time.time() - start_time
                                        
                                        # Log API usage to MongoDB
                                        if (
                                            self.mongodb_client is not None
                                            and self.llm_usage_collection is not None
                                        ):
                                            try:
                                                # Extract usage information
                                                usage = complete_message.get("usage", {})
                                                input_tokens = usage.get("input_tokens", 0)
                                                output_tokens = usage.get("output_tokens", 0)
                                                cache_creation_input_tokens = usage.get(
                                                    "cache_creation_input_tokens", 0
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
                                                    "request_id": complete_message.get("id", "unknown"),
                                                    "request_type": "chat_streaming",
                                                }

                                                # Log asynchronously without waiting for completion
                                                await self.llm_usage_collection.insert_one(llm_usage)
                                            except Exception as log_error:
                                                console.print(
                                                    f"[warning]Failed to log API usage: {str(log_error)}[/warning]"
                                                )
                                        
                                        yield {"type": "message_stop", "data": data, "complete_message": complete_message}
                                    
                                    else:
                                        # Handle any other event types
                                        yield {"type": event_type, "data": data}
                                        
                                except json.JSONDecodeError as e:
                                    console.print(f"[warning]Failed to parse JSON line: {line}[/warning]")
                                    console.print(f"[warning]JSON decode error: {e}[/warning]")
                                    # Skip malformed JSON lines
                                    continue
                            elif line.startswith("event: "):
                                # Event type line, we can ignore this as the type is in the data
                                continue
                            elif line.strip() == "":
                                # Empty line, continue
                                continue
                            else:
                                console.print(f"[warning]Unexpected line format: {line}[/warning]")
                    
                    except httpx.HTTPStatusError as e:
                        # For streaming responses, we can't access response.text directly
                        # Try to read the response content if possible, otherwise just use the status
                        try:
                            error_content = await response.aread()
                            error_text = error_content.decode('utf-8') if error_content else "No error details available"
                        except:
                            error_text = f"HTTP {e.response.status_code} error"
                        
                        console.print(
                            f"[error]Error in Anthropic Streaming API: {error_text} - {str(e)}[/error]"
                        )
                        yield {"type": "error", "data": {"error": str(e), "details": error_text}}
                            
        except httpx.RequestError as e:
            console.print(
                f"[error]Request Error in Anthropic Streaming API call: {str(e)}[/error]"
            )
            yield {"type": "error", "data": {"error": str(e)}}
        except httpx.HTTPError as e:
            console.print(
                f"[error]Error in Anthropic Streaming API call HTTPError: {str(e)}[/error]"
            )
            yield {"type": "error", "data": {"error": str(e)}}
        except Exception as e:
            console.print(
                f"[error]Error in Anthropic Streaming API call: {str(e)}[/error]"
            )
            yield {"type": "error", "data": {"error": str(e)}}

    async def process_streaming_tool_calls(self, depth=0):
        """
        Process tool calls with streaming, allowing the model to make multiple tool calls
        until it provides a final answer. Updates agent memory with all actions taken.
        """
        if depth >= self.MAX_TOOL_CALL_DEPTH:
            console.print(
                Panel(
                    "Maximum tool call depth reached. Stopping to prevent infinite loops.",
                    title="[error]Error[/error]",
                    border_style="red",
                )
            )
            # Add exit logic when MAX_TOOL_CALL_DEPTH is reached
            await self.cleanup()
            console.print(
                "[success]Session ended due to reaching MAX_TOOL_CALL_DEPTH[/success]"
            )
            sys.exit(0)

        # Stream the API call
        complete_message = None
        thinking_content = ""
        text_content = ""
        tool_calls = []
        
        console.print()
        console.print(
            f"[thinking]Generating response (depth {depth})...[/thinking]"
        )

        async for stream_event in self.anthropic_streaming_api_call(
            messages=self.agent_memory.get_conversation_messages(),
            tools=self.anthropic_tools,
        ):
            event_type = stream_event.get("type")
            data = stream_event.get("data", {})
            
            if event_type == "content_block_start":
                content_block = data.get("content_block", {})
                if content_block.get("type") == "thinking":
                    console.print()
                    console.print("[thinking]Assistant's Reasoning:[/thinking]", end="")
                elif content_block.get("type") == "text":
                    console.print()
                    console.print("[assistant]Assistant:[/assistant]", end="")
                elif content_block.get("type") == "tool_use":
                    # Don't add to tool_calls here, wait for complete block
                    console.print()
                    console.print(f"[tool]Preparing to use tool: {content_block.get('name', 'unknown')}[/tool]")
            
            elif event_type == "content_block_delta":
                delta = data.get("delta", {})
                if delta.get("type") == "thinking_delta":
                    thinking_text = delta.get("thinking", "")
                    thinking_content += thinking_text
                    console.print(thinking_text, end="", style="thinking")
                elif delta.get("type") == "text_delta":
                    text_chunk = delta.get("text", "")
                    text_content += text_chunk
                    console.print(text_chunk, end="", style="assistant")
                elif delta.get("type") == "input_json_delta":
                    # Tool input is being streamed, we can show progress
                    console.print(".", end="", style="tool")
            
            elif event_type == "content_block_stop":
                console.print()  # New line after content block ends
            
            elif event_type == "message_stop":
                complete_message = stream_event.get("complete_message")
                break
        
        if not complete_message:
            console.print(
                Panel(
                    "Error: Couldn't get a complete response from the LLM.",
                    title="[error]Error[/error]",
                    border_style="red",
                )
            )
            return {"message": "Error: Couldn't get a complete response from the LLM."}, self.agent_memory

        # Create assistant message from complete response
        assistant_message = {
            "role": "assistant",
            "content": complete_message.get("content", []),
        }

        # Debug: Show the final assistant message structure
        console.print(f"[info]DEBUG: Final assistant message structure:[/info]")
        for i, block in enumerate(assistant_message["content"]):
            block_type = block.get("type", "unknown")
            if block_type == "thinking":
                console.print(f"[info]  Block {i}: thinking (length: {len(block.get('thinking', ''))})[/info]")
                # Check if signature field exists (it should for thinking blocks)
                if "signature" in block:
                    console.print(f"[info]    - Has signature (length: {len(block['signature'])})[/info]")
                else:
                    console.print(f"[warning]    - Missing signature field![/warning]")
            elif block_type == "text":
                console.print(f"[info]  Block {i}: text (length: {len(block.get('text', ''))})[/info]")
            elif block_type == "tool_use":
                console.print(f"[info]  Block {i}: tool_use - {block.get('name', 'unknown')} with {len(block.get('input', {}))} parameters[/info]")
            else:
                console.print(f"[info]  Block {i}: {block_type}[/info]")

        # Extract content blocks from complete response
        content_blocks = complete_message.get("content", [])
        has_tool_calls = False
        tool_calls = []

        # Check for tool_use blocks in the content
        for block in content_blocks:
            if block.get("type") == "tool_use":
                has_tool_calls = True
                tool_calls.append(block)
                console.print(f"[info]Found tool_use block: {block.get('name', 'unknown')} with id {block.get('id', 'unknown')}[/info]")

        # If no tool calls, just return the text response
        if not has_tool_calls:
            # Add the assistant's final response to memory
            self.agent_memory.add_assistant_message(assistant_message)
            return {"message": text_content}, self.agent_memory

        # Add the assistant message with tool calls to memory
        self.agent_memory.add_assistant_message(assistant_message)

        # Process each tool call
        for tool_call in tool_calls:
            tool_use_id = tool_call.get("id")
            tool_name = tool_call.get("name")
            tool_input = tool_call.get("input", {})

            # Add detailed logging for debugging
            console.print(f"[info]DEBUG: Processing tool call:[/info]")
            console.print(f"[info]  - Tool ID: {tool_use_id}[/info]")
            console.print(f"[info]  - Tool Name: {tool_name}[/info]")
            console.print("[info]  - Tool Input:[/info]")
            console.print(json.dumps(tool_input, indent=2), markup=False)
            console.print("[info]  - Raw Tool Call:[/info]")
            console.print(json.dumps(tool_call, indent=2), markup=False)

            # Check if total tool calls will exceed 25
            if self.agent_memory.total_tool_calls >= 50:
                console.print(
                    Panel(
                        f"[bold yellow]The agent has already made 25 tool calls in this session.[/bold yellow]\nContinuing might lead to longer processing times.",
                        title="[warning]Tool Call Limit Reached[/warning]",
                        border_style="yellow",
                    )
                )
                permission = (
                    input(
                        "Do you want to continue with more tool calls? (yes/no): "
                    )
                    .strip()
                    .lower()
                )
                if permission not in ["yes", "y"]:
                    # If user doesn't want to continue, clean up and exit
                    console.print(
                        "[info]Stopping further tool calls as requested.[/info]"
                    )
                    await self.cleanup()
                    console.print("[success]Session ended by user[/success]")
                    sys.exit(0)

            # Add a permission check for run_terminal_cmd
            if tool_name == "run_terminal_command":
                command = tool_input.get("command", "")
                console.print(
                    Panel(
                        f"[bold yellow]The agent wants to run the following terminal command:[/bold yellow]\n[bold]{command}[/bold]",
                        title="[warning]Permission Required[/warning]",
                        border_style="yellow",
                    )
                )

                permission = (
                    input("Do you want to allow this command? (yes/no): ")
                    .strip()
                    .lower()
                )
                if permission not in ["yes", "y"]:
                    # If permission denied, skip this tool call and notify the agent
                    console.print(
                        "[error]Permission denied for running terminal command.[/error]"
                    )
                    tool_content = "ERROR: Permission denied for running terminal command. The user did not approve this command execution."
                    self.agent_memory.add_tool_call(tool_call, tool_content)
                    self.agent_memory.add_tool_result(tool_use_id, tool_content)
                    continue

            # Create a nice panel for the tool call
            console.print()
            console.print(
                Panel(
                    f"[bold]Arguments:[/bold]\n{json.dumps(tool_input, indent=2)}",
                    title=f"[tool]Using Tool: {tool_name}[/tool]",
                    border_style="magenta",
                )
            )

            # Call the MCP tool with a spinner
            try:
                with console.status(
                    f"[thinking]Executing {tool_name}...[/thinking]"
                ):
                    # Check if session exists before calling
                    if not self.session:
                        raise Exception("Session is not initialized")
                    
                    tools_requiring_workspace_path = {
                        "run_terminal_command", 
                        "search_and_replace", 
                        "search_files"
                    }
                    
                    if tool_name in tools_requiring_workspace_path and self.workspace_path:
                        # Only add workspace_path if it's not already in the tool_input
                        if "workspace_path" not in tool_input:
                            tool_input["workspace_path"] = self.workspace_path
                            console.print(
                                f"[info]Injected workspace_path for {tool_name}: {self.workspace_path}[/info]"
                            )
                            
                    if tool_name == "list_directory" and self.workspace_path:
                        if tool_input.get("dir_path") == ".":
                            tool_input["dir_path"] = self.workspace_path
                            
                    tool_result = await self.session.call_tool(
                        tool_name, tool_input
                    )

                # Process result
                if tool_result:
                    # Handle MCP tool result format - simple string conversion
                    try:
                        if isinstance(tool_result, list):
                            tool_content = "\n".join(str(item) for item in tool_result)
                        else:
                            tool_content = str(tool_result)
                    except Exception as e:
                        console.print(f"[error]Error processing tool result: {e}[/error]")
                        tool_content = f"Tool completed (result processing error: {e})"

                    # Limit content length to avoid issues with very large inputs
                    original_length = len(tool_content)
                    if original_length > 32000:  # Adjust threshold as needed
                        tool_content = (
                            tool_content[:32000]
                            + f"\n[Content truncated from {original_length} to 32000 characters]"
                        )
                        console.print(
                            f"[warning]Truncated tool result from {original_length} to 32000 characters[/warning]"
                        )
                else:
                    tool_content = "No result from tool"
                    logger.info(
                        f"No response got from the tool might have error while using the tool"
                    )

                # Record the tool call and result in agent memory
                self.agent_memory.add_tool_call(tool_call, tool_content)
                self.agent_memory.add_tool_result(tool_use_id, tool_content)

                # Display the result in a nice format (syntax highlighting if it looks like code)
                if tool_content.strip().startswith(("{", "[", "<", "```")):
                    # Likely JSON or code - use syntax highlighting
                    console.print(
                        Panel(
                            Syntax(
                                tool_content,
                                (
                                    "python"
                                    if tool_content.strip().startswith(
                                        "```python"
                                    )
                                    else "json"
                                ),
                                theme="monokai",
                                word_wrap=True,
                            ),
                            title="[success]Tool Result[/success]",
                            border_style="green",
                        )
                    )
                else:
                    # Plain text result
                    console.print(
                        Panel(
                            tool_content,
                            title="[success]Tool Result[/success]",
                            border_style="green",
                        )
                    )

                console.print(
                    f"[tool_result]Result length: {len(tool_content)} characters[/tool_result]"
                )
            except Exception as e:
                error_message = f"Error calling tool {tool_name}: {str(e)}"
                console.print(f"[error]{error_message}[/error]")
                # Still record the attempt in memory
                self.agent_memory.add_tool_call(tool_call, f"ERROR: {str(e)}")
                self.agent_memory.add_tool_result(tool_use_id, error_message)

        # Make next call to Anthropic with tool results (recursive call)
        return await self.process_streaming_tool_calls(depth + 1)

    async def initialize_session(self, server_url, transport_type, workspace_path, system_info=None, workspace_id=None):
        """Initialize the MCP session with optional system information and workspace ID"""
        try:
            # Store workspace path, system info, and workspace ID
            self.workspace_path = workspace_path or os.getcwd()
            if system_info:
                self.set_system_info(system_info)
            if workspace_id:
                self.set_workspace_id(workspace_id)
            
            console.print(f"[info]Initializing session with workspace: {self.workspace_path}[/info]")
            if workspace_id:
                console.print(f"[info]Workspace ID: {workspace_id}[/info]")
            
            # Connect to MCP server
            with console.status(
                f"[info]Connecting to MCP server via {transport_type}...[/info]"
            ):
                if transport_type.lower() == "sse":
                    self.client_context = sse_client(server_url)
                    streams = await self.client_context.__aenter__()
                else:  # stdio
                    # Fix missing server parameter
                    self.client_context = stdio_client(server=server_url)
                    streams = await self.client_context.__aenter__()

                # Create client session
                self.session = ClientSession(streams[0], streams[1])
                await self.session.__aenter__()
                await self.session.initialize()

            console.print(
                "[success]✓ Connected to MCP server successfully![/success]"
            )

            # Get available tools
            with console.status("[info]Loading available tools...[/info]"):
                tools = await self.session.list_tools()

            if not tools or not hasattr(tools, "tools") or not tools.tools:
                console.print(
                    "[error]No tools available from the MCP server.[/error]"
                )
                return False

            # Create a nice table to display available tools
            table = Table(title="Available Tools", border_style="bright_cyan")
            table.add_column("Tool Name", style="cyan")
            table.add_column("Description", style="green")

            for tool in tools.tools:
                table.add_row(tool.name, tool.description)

            console.print(table)

            # Convert MCP tools to Anthropic format
            self.anthropic_tools = []
            for tool in tools.tools:
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
            system_info_context = self._format_system_info_context()
            
            # Get workspace context if workspace ID is available
            workspace_context = await self.get_workspace_context() if workspace_id else ""
            
            # Use the actual workspace path and system info
            system_message = CODING_AGENT_SYSTEM_PROMPT.format(
                system_info_context=system_info_context,
            )
            
            # Add workspace context to system message if available
            if workspace_context:
                system_message += f"\n\n{workspace_context}"
            
            console.print(f"[info]Using system information:\n{system_info_context}[/info]")
            if workspace_context:
                console.print("[info]Workspace context loaded and added to system prompt[/info]")
            
            # Initialize agent memory with system message
            console.print("[info]Initializing agent system prompt with system information and workspace context[/info]")
            self.agent_memory.initialize_with_system_message(system_message)
            return True

        except Exception as e:
            console.print(
                f"[error]Error initializing session: {str(e)}[/error]"
            )
            return False

    async def run_interactive_session(
        self,
        server_url: str = "http://0.0.0.0:8001/sse",
        transport_type: str = "sse",
        workspace_path: Optional[str] = None,
    ):
        """Run an interactive session with the LLM using MCP tools with agent memory and streaming"""
        # Show a welcome banner
        console.print(
            Panel(
                "[bold]Welcome to the Anthropic Streaming Coding Assistant[/bold]\n"
                "Ask coding questions, request code explanations, or get help with your projects.\n"
                "[dim]This version uses real-time streaming for faster responses![/dim]",
                title="[bold]🤖 Anthropic Streaming Agent[/bold]",
                border_style="green",
                width=100,
            )
        )

        console.print(
            f"[info]Connecting to MCP server using {transport_type} transport at {server_url}...[/info]"
        )

        try:
            # Initialize the session
            if not await self.initialize_session(server_url, transport_type, workspace_path):
                return

            # Interactive loop
            while True:
                # Get user query with styled prompt
                user_query = Prompt.ask(
                    "\n[user]What can I help you with?[/user]"
                )
                if user_query.lower() in ("exit", "quit"):
                    # Clean up and exit when user types exit or quit
                    console.print("[info]Exiting as requested...[/info]")
                    await self.cleanup()
                    console.print("[success]Session ended[/success]")
                    sys.exit(0)

                # Add user message to the conversation visually
                console.print(
                    Panel(
                        user_query,
                        title="[user]You[/user]",
                        border_style="blue",
                    )
                )

                # Process the user query
                enhanced_query = user_query

                # Add internal agent memory context
                tool_usage_summary = self.agent_memory.get_tool_usage_summary()
                if self.agent_memory.total_tool_calls > 0:
                    memory_context = f"\n--- Agent Memory Reflection ---\n{tool_usage_summary}\n--- End Memory Reflection ---\n\n"
                    enhanced_query = f"{memory_context}{enhanced_query}"

                # Add the user message to agent memory
                self.agent_memory.add_user_message(enhanced_query)
                
                # Process with streaming tool calls
                result, updated_agent_memory = await self.process_streaming_tool_calls()

                # Update our agent memory with the results
                self.agent_memory = updated_agent_memory

                # The response has already been streamed to console during processing
                console.print()  # Add some spacing

        except KeyboardInterrupt:
            console.print(
                "\n[warning]Exiting due to keyboard interrupt...[/warning]"
            )
        except Exception as e:
            console.print(
                f"\n[error]Error in interactive session: {str(e)}[/error]"
            )
            import traceback

            console.print(
                Syntax(traceback.format_exc(), "python", theme="monokai")
            )
        finally:
            # Properly clean up resources
            with console.status("[info]Cleaning up resources...[/info]"):
                await self.cleanup()
            console.print("[success]Session ended successfully[/success]")

    async def cleanup(self):
        """Clean up resources before exiting"""
        try:
            if self.session:
                try:
                    await self.session.__aexit__(None, None, None)
                except AttributeError as e:
                    # Handle TaskGroup._exceptions AttributeError gracefully
                    if "_exceptions" in str(e):
                        console.print(
                            "[info]Handled known session closure issue[/info]"
                        )
                    else:
                        console.print(
                            f"[error]Session attribute error: {str(e)}[/error]"
                        )
                except Exception as e:
                    console.print(
                        f"[error]Error closing session: {str(e)}[/error]"
                    )

            if self.client_context:
                try:
                    await self.client_context.__aexit__(None, None, None)
                except Exception as e:
                    console.print(
                        f"[error]Error closing client context: {str(e)}[/error]"
                    )
        except Exception as e:
            console.print(f"[error]Error during cleanup: {str(e)}[/error]")

    @classmethod
    async def main_async(
        cls,
        server_url: str = settings.MCP_BASE_URL,
        transport_type: str = "sse",
        workspace_path: Optional[str] = None,
    ):
        agent = cls()
        await agent.run_interactive_session(server_url, transport_type, workspace_path)

    @classmethod
    def main(cls):
        # Get transport type from command line args
        transport = "sse"
        server_url = settings.MCP_BASE_URL

        if len(sys.argv) > 1:
            transport = sys.argv[1]

        if len(sys.argv) > 2:
            server_url = sys.argv[2]

        # Create a beautiful startup screen
        console.clear()
        console.print(
            Panel(
                "[bold cyan]Anthropic[/bold cyan] [bold green]Streaming[/bold green] [bold magenta]Assistant[/bold magenta]\n\n"
                "A powerful AI coding assistant with real-time streaming and tool-using capabilities\n"
                f"[dim]Server: {server_url}[/dim]\n"
                f"[dim]Transport: {transport}[/dim]",
                title="[bold]🚀 Starting Up[/bold]",
                border_style="bright_blue",
                expand=False,
                padding=(1, 2),
            )
        )

        asyncio.run(cls.main_async(server_url, transport))


if __name__ == "__main__":
    AnthropicStreamingAgent.main() 