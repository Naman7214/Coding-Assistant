import asyncio
import json
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional

import uvicorn
from agent_with_stream import AnthropicStreamingAgent
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from models.schema.context_schema import ActiveFileContext, SystemInfo
from models.schema.request_schema import (
    PermissionResponse,
    QueryRequest,
    StreamEvent,
)

# Create FastAPI app
app = FastAPI(title="Agent True Streaming API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store a global instance of the streaming agent
agent_instance = None
# Store pending permission requests
pending_permissions = {}

# Context API base URL (extension's context server)
CONTEXT_API_BASE = "http://localhost:3001"


@app.on_event("startup")
async def startup_event():
    global agent_instance
    agent_instance = AnthropicStreamingAgent()
    print(f"✅ Enhanced Streaming Agent instance created successfully")


@app.on_event("shutdown")
async def shutdown_event():
    global agent_instance
    if agent_instance:
        await agent_instance.cleanup()
        print("✅ Enhanced Streaming Agent cleaned up successfully")


def create_stream_event(
    event_type: str, content: str, metadata: Optional[Dict[str, Any]] = None
) -> str:
    """Create a Server-Sent Event formatted string"""
    event = StreamEvent(
        type=event_type,
        content=content,
        metadata=metadata or {},
        timestamp=time.time(),
    )
    return f"data: {event.json()}\n\n"


async def stream_agent_response(
    query: str,
    workspace_path: str,
    hashed_workspace_path: str,
    git_branch: str,
    system_info: Optional[SystemInfo] = None,
    active_file_context: Optional[ActiveFileContext] = None,
    context_mentions: Optional[List[str]] = None,
) -> AsyncGenerator[str, None]:
    """Stream the agent's response with enhanced context system"""
    global agent_instance

    print(f"🚀 Enhanced stream request received:")
    print(f"   Query: {query[:100]}...")
    print(f"   Workspace Path: {workspace_path}")
    print(f"   Hashed Workspace Path: {hashed_workspace_path}")
    print(f"   Git Branch: {git_branch}")
    print(f"   Context Mentions: {context_mentions}")
    if system_info:
        print(f"   System: {system_info.platform} {system_info.osVersion}")
    if active_file_context:
        print(f"   Active File: {active_file_context.relativePath}")

    # Check if agent is initialized
    if not agent_instance or not agent_instance.client:
        try:
            agent_instance = AnthropicStreamingAgent()
            server_url = "http://localhost:8001/sse"
            transport_type = "sse"
            print(
                f"🔧 Initializing enhanced agent with workspace: {workspace_path}"
            )

            # Initialize agent with enhanced context system
            await agent_instance.initialize_session(
                server_url,
                transport_type,
                workspace_path,
                system_info.model_dump() if system_info else None,
            )
        except Exception as e:
            yield create_stream_event(
                "error", f"Failed to initialize enhanced agent: {str(e)}"
            )
            return

    # Update agent with always-send context
    if system_info:
        agent_instance.set_system_info(system_info.model_dump())
    if active_file_context:
        agent_instance.set_active_file_context(
            active_file_context.model_dump() if active_file_context else None
        )

    try:
        yield create_stream_event(
            "thinking",
            "Processing your request with enhanced context system...",
            {
                "query": query,
                "workspace": workspace_path,
                "context_mentions": context_mentions,
                "active_file": (
                    active_file_context.relativePath
                    if active_file_context
                    else None
                ),
            },
        )

        # Update agent memory with enhanced context
        await agent_instance.update_context_memory(
            system_info=system_info.model_dump() if system_info else None,
            active_file=(
                active_file_context.model_dump()
                if active_file_context
                else None
            ),
        )

        # Add the query to agent memory
        agent_instance.agent_memory.add_user_message(query)

        yield create_stream_event(
            "thinking", "Generating response with enhanced streaming..."
        )

        # Process with enhanced streaming tool calls
        async for event in process_enhanced_streaming_tool_calls(depth=0):
            yield event

    except Exception as e:
        print(f"Error processing enhanced query: {str(e)}")
        import traceback

        traceback.print_exc()
        yield create_stream_event(
            "error", f"Enhanced processing error: {str(e)}"
        )

    print("✅ Enhanced streaming query completed")


@app.post("/stream")
async def stream_query(request: QueryRequest):
    """Stream the agent's enhanced response with context system"""
    try:

        print(f"🚀 Enhanced /stream endpoint called:")
        print(f"   Query: {request.query[:100]}...")
        print(f"   Hashed Workspace Path: {request.hashed_workspace_path}")
        print(f"   Git Branch: {request.git_branch}")
        print(f"   Context Mentions: {request.context_mentions}")
        print(f"   System Info: {bool(request.system_info)}")
        print(f"   Active File: {bool(request.active_file_context)}")

        return StreamingResponse(
            stream_agent_response(
                request.query,
                request.workspace_path,
                request.hashed_workspace_path,
                request.git_branch,
                request.system_info,
                request.active_file_context,
                request.context_mentions,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*",
            },
        )
    except Exception as e:
        print(f"Error in enhanced stream_query: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/permission")
async def handle_permission_response(response: PermissionResponse):
    """Handle permission response from frontend"""
    permission_id = response.permission_id
    granted = response.granted

    if permission_id in pending_permissions:
        future = pending_permissions[permission_id]
        if not future.done():
            future.set_result(granted)
        return {
            "status": "success",
            "message": f"Permission {'granted' if granted else 'denied'}",
        }
    else:
        raise HTTPException(
            status_code=404, detail="Permission request not found or expired"
        )


@app.post("/health")
async def health_check():
    global agent_instance

    # Check if agent instance exists and is ready
    if agent_instance:
        # If agent has been initialized at least once
        return {
            "status": "healthy",
            "streaming": True,
            "session_initialized": bool(agent_instance.client),
            "ready_for_requests": True,
        }
    else:
        # Agent instance created but no session yet - this is normal on startup
        return {
            "status": "healthy",
            "streaming": True,
            "session_initialized": False,
            "ready_for_requests": True,
            "note": "Agent will initialize session on first request",
        }


@app.post("/reset")
async def reset_agent_endpoint():
    """API endpoint to reset the agent in case of errors"""
    try:
        await reset_agent()
        return {"status": "success", "message": "Agent reset successfully"}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to reset agent: {str(e)}"
        )


@app.post("/sanitize")
async def sanitize_conversation():
    """API endpoint to sanitize the conversation history to remove duplicate tool IDs"""
    global agent_instance
    if not agent_instance:
        raise HTTPException(status_code=400, detail="Agent not initialized")

    try:
        original_length = len(agent_instance.agent_memory.full_history)
        fixed = sanitize_conversation_history(
            agent_instance.agent_memory.full_history
        )
        agent_instance.agent_memory.full_history = fixed
        return {
            "status": "success",
            "message": f"Conversation sanitized. Original length: {original_length}, New length: {len(fixed)}",
        }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to sanitize conversation: {str(e)}"
        )


def sanitize_conversation_history(history):
    """Remove duplicate tool IDs from conversation history"""
    # Track tool IDs we've seen
    seen_tool_ids = set()
    sanitized_history = []

    for message in history:
        # Handle system and user messages normally
        if message.get("role") in ["system", "user"]:
            sanitized_history.append(message)
            continue

        # For assistant messages, check content blocks for tool_use blocks
        if message.get("role") == "assistant" and "content" in message:
            content_blocks = []
            for block in message.get("content", []):
                # If it's a tool_use block, check for duplicate ID
                if block.get("type") == "tool_use" and "id" in block:
                    tool_id = block.get("id")
                    if tool_id in seen_tool_ids:
                        # Generate a new unique ID
                        new_id = f"fixed_tool_{uuid.uuid4().hex[:8]}"
                        print(
                            f"Fixing duplicate tool ID: {tool_id} -> {new_id}"
                        )
                        block = (
                            block.copy()
                        )  # Create a copy to avoid modifying the original
                        block["id"] = new_id
                    seen_tool_ids.add(block.get("id"))
                content_blocks.append(block)

            # Create a new message with fixed content blocks
            fixed_message = message.copy()
            fixed_message["content"] = content_blocks
            sanitized_history.append(fixed_message)
        else:
            # Handle other message types normally
            sanitized_history.append(message)

    return sanitized_history


@app.get("/")
async def root():
    return {"message": "Agent TRUE Streaming API is running", "streaming": True}


async def reset_agent():
    """Reset the agent completely when conversation errors occur"""
    global agent_instance

    # Store the current workspace path and system info before cleanup
    current_workspace_path = (
        agent_instance.workspace_path if agent_instance else None
    )
    current_system_info = agent_instance.system_info if agent_instance else None

    # Clean up existing agent if any
    if agent_instance:
        try:
            await agent_instance.cleanup()
        except Exception as e:
            print(f"Error cleaning up agent: {e}")

    # Create a fresh agent instance
    try:
        agent_instance = AnthropicStreamingAgent()
        server_url = "http://localhost:8001/sse"
        transport_type = "sse"
        # Use the preserved workspace path and system info
        success = await agent_instance.initialize_session(
            server_url,
            transport_type,
            current_workspace_path,
            current_system_info,
        )
        if success:
            print("✅ Agent reset successfully with preserved system info")
        else:
            print("❌ Failed to reset agent")
    except Exception as e:
        print(f"❌ Error creating new agent instance: {e}")
        agent_instance = None


async def process_enhanced_streaming_tool_calls(
    depth=0, context_data=None
) -> AsyncGenerator[str, None]:
    """
    Enhanced process tool calls with context awareness and streaming
    """
    global agent_instance

    MAX_TOOL_CALL_DEPTH = 100

    if depth >= MAX_TOOL_CALL_DEPTH:
        yield create_stream_event(
            "error",
            "Maximum tool call depth reached. Stopping to prevent infinite loops.",
        )
        return

    # Check if agent_instance is available
    if not agent_instance:
        yield create_stream_event("error", "Agent instance is not available.")
        return

    # Stream the API call
    complete_message = None
    thinking_content = ""
    text_content = ""
    tool_calls = []

    # Don't send initial thinking message for depth > 0
    if depth == 0:
        yield create_stream_event(
            "thinking", "Starting to process your request..."
        )

    async for stream_event in agent_instance.anthropic_streaming_api_call(
        messages=agent_instance.agent_memory.get_conversation_messages(),
        tools=agent_instance.anthropic_tools,
    ):
        event_type = stream_event.get("type")
        data = stream_event.get("data", {})

        if event_type == "content_block_start":
            content_block = data.get("content_block", {})
            block_type = content_block.get("type")

            if block_type == "thinking":
                # Start thinking mode
                pass  # Don't send duplicate thinking events
            elif block_type == "text":
                # Assistant is about to start responding
                pass  # Wait for actual content
            elif block_type == "tool_use":
                tool_name = content_block.get("name", "unknown")
                friendly_name = get_friendly_tool_name(tool_name)
                yield create_stream_event(
                    "tool_selection",
                    f"Using: {friendly_name}",
                    {"tool_name": tool_name, "friendly_name": friendly_name},
                )

        elif event_type == "content_block_delta":
            delta = data.get("delta", {})
            delta_type = delta.get("type")

            if delta_type == "thinking_delta":
                thinking_text = delta.get("thinking", "")
                thinking_content += thinking_text
                if (
                    thinking_text.strip()
                ):  # Only send non-empty thinking content
                    yield create_stream_event("thinking", thinking_text)
            elif delta_type == "text_delta":
                text_chunk = delta.get("text", "")
                text_content += text_chunk
                if text_chunk:
                    yield create_stream_event("assistant_response", text_chunk)
            elif delta_type == "input_json_delta":
                # Tool input is being streamed - show friendly progress
                yield create_stream_event(
                    "tool_execution", ".", {"status": "preparing"}
                )

        elif event_type == "content_block_stop":
            # Content block ended - we can finalize tool information here
            pass

        elif event_type == "message_stop":
            complete_message = stream_event.get("complete_message")
            print(f"Enhanced: Received message_stop at depth {depth}")
            break

    if not complete_message:
        if depth > 0:
            print(f"Enhanced: Depth > 0, treating as successful completion")
            yield create_stream_event(
                "final_response", "Task completed successfully."
            )
            return
        else:
            yield create_stream_event(
                "error", "Couldn't get a complete response from the LLM."
            )
            return

    # Create assistant message from complete response
    assistant_message = {
        "role": "assistant",
        "content": complete_message.get("content", []),
    }

    # Extract content blocks from complete response
    content_blocks = complete_message.get("content", [])
    has_tool_calls = False
    tool_calls = []

    # Check for tool_use blocks in the content
    for block in content_blocks:
        if block.get("type") == "tool_use":
            has_tool_calls = True
            tool_calls.append(block)

    # If no tool calls, just return the text response
    if not has_tool_calls:
        print(f"Enhanced: No tool calls at depth {depth}")
        # Add the assistant's final response to memory
        agent_instance.agent_memory.add_assistant_message(assistant_message)
        if text_content:
            yield create_stream_event("final_response", text_content)
        else:
            # If no text content, send a generic completion message
            yield create_stream_event(
                "final_response", "Task completed successfully."
            )
        return

    # Add the assistant message with tool calls to memory
    agent_instance.agent_memory.add_assistant_message(assistant_message)

    # Process each tool call with enhanced context awareness
    for tool_call in tool_calls:
        tool_use_id = tool_call.get("id")
        tool_name = tool_call.get("name")
        tool_input = tool_call.get("input", {})

        friendly_name = get_friendly_tool_name(tool_name)
        yield create_stream_event(
            "tool_execution",
            f"Running {friendly_name}...",
            {
                "tool_name": tool_name,
                "friendly_name": friendly_name,
                "tool_arguments": tool_input,
                "tool_use_id": tool_use_id,
                "status": "executing",
            },
        )

        # Handle permission for terminal commands
        if tool_name == "run_terminal_command":
            command = tool_input.get("command", "")
            is_background = tool_input.get("is_background", False)
            permission_id = f"perm_{tool_use_id}_{int(time.time())}"

            permission_future = asyncio.Future()
            pending_permissions[permission_id] = permission_future

            yield create_stream_event(
                "permission_request",
                f"Permission required to run command: {command}",
                {
                    "requires_permission": True,
                    "command": command,
                    "permission_id": permission_id,
                    "tool_name": tool_name,
                    "is_background": is_background,
                },
            )

            try:
                permission_granted = await asyncio.wait_for(
                    permission_future, timeout=60.0
                )

                if not permission_granted:
                    yield create_stream_event(
                        "tool_result",
                        "Permission denied by user",
                        {
                            "tool_name": tool_name,
                            "tool_use_id": tool_use_id,
                            "friendly_name": friendly_name,
                            "error": True,
                            "permission_denied": True,
                        },
                    )
                    agent_instance.agent_memory.add_tool_call(
                        tool_call, "Permission denied by user"
                    )
                    agent_instance.agent_memory.add_tool_result(
                        tool_use_id, "Permission denied by user"
                    )
                    continue

                print(f"Enhanced: Permission granted for command: {command}")

            except asyncio.TimeoutError:
                yield create_stream_event(
                    "tool_result",
                    "Permission request timed out",
                    {
                        "tool_name": tool_name,
                        "tool_use_id": tool_use_id,
                        "friendly_name": friendly_name,
                        "error": True,
                        "timeout": True,
                    },
                )
                agent_instance.agent_memory.add_tool_call(
                    tool_call, "Permission request timed out"
                )
                agent_instance.agent_memory.add_tool_result(
                    tool_use_id, "Permission request timed out"
                )
                continue
            finally:
                pending_permissions.pop(permission_id, None)

        # Enhanced tool execution with context injection
        try:
            if not agent_instance.client:
                raise Exception("Client is not initialized")

            # Enhanced workspace path injection for tools that need it (BEFORE tool call)
            tools_requiring_workspace_path = {
                "run_terminal_command",
                "search_and_replace",
                "search_files",
                "list_directory",
                "read_file",
                "delete_file",
            }

            if (
                tool_name in tools_requiring_workspace_path
                and agent_instance.workspace_path
            ):
                if "workspace_path" not in tool_input:
                    tool_input["workspace_path"] = agent_instance.workspace_path
                    print(
                        f"✅ Enhanced: Injected workspace_path for {tool_name}"
                    )

            if tool_name == "list_directory" and agent_instance.workspace_path:
                if tool_input.get("dir_path") == ".":
                    tool_input["dir_path"] = agent_instance.workspace_path
                    print(f"✅ Enhanced: Updated dir_path for {tool_name}")

            tool_result = await agent_instance.client.call_tool(
                tool_name, tool_input
            )

            print(f"Enhanced: Tool input: {tool_input}")
            print(
                f"Enhanced: Received result from MCP server for tool: {tool_name}"
            )

            if tool_result:
                # Enhanced result processing
                try:
                    if isinstance(tool_result, list):
                        tool_content = "\n".join(
                            str(item) for item in tool_result
                        )
                    else:
                        tool_content = str(tool_result)
                except Exception as e:
                    print(f"Enhanced: Error processing tool result: {e}")
                    tool_content = (
                        f"Tool completed (result processing error: {e})"
                    )

                # Enhanced content length management
                original_length = len(tool_content)
                if original_length > 8000:
                    tool_content = (
                        tool_content[:8000]
                        + f"\n[Content truncated from {original_length} to 8000 characters]"
                    )
            else:
                tool_content = "No result from tool"

            # Stream enhanced tool result
            yield create_stream_event(
                "tool_result",
                tool_content,
                {
                    "tool_name": tool_name,
                    "friendly_name": friendly_name,
                    "tool_use_id": tool_use_id,
                    "result_length": len(tool_content),
                    "truncated": (
                        original_length > 8000
                        if "original_length" in locals()
                        else False
                    ),
                },
            )

            # Record the tool call and result in agent memory
            agent_instance.agent_memory.add_tool_call(tool_call, tool_content)
            agent_instance.agent_memory.add_tool_result(
                tool_use_id, tool_content
            )

        except Exception as e:
            error_message = f"Error calling tool {tool_name}: {str(e)}"
            yield create_stream_event(
                "tool_result",
                error_message,
                {
                    "tool_name": tool_name,
                    "friendly_name": friendly_name,
                    "tool_use_id": tool_use_id,
                    "error": True,
                },
            )
            agent_instance.agent_memory.add_tool_call(
                tool_call, f"ERROR: {str(e)}"
            )
            agent_instance.agent_memory.add_tool_result(
                tool_use_id, error_message
            )

    # Enhanced recursive call with context preservation
    print(f"Enhanced: Making recursive call with depth {depth + 1}")

    has_final_response = False
    async for event in process_enhanced_streaming_tool_calls(
        depth + 1, context_data
    ):
        yield event
        # Check if we got a final_response
        try:
            event_data = json.loads(event.replace("data: ", ""))
            if event_data.get("type") == "final_response":
                has_final_response = True
        except (json.JSONDecodeError, AttributeError):
            pass

    # If no final response was sent, send one to complete the stream
    if not has_final_response:
        print(
            f"Enhanced: No final response received at depth {depth + 1}, sending completion"
        )
        yield create_stream_event(
            "final_response", "All tasks completed successfully."
        )

    print(f"Enhanced: Completed recursive call with depth {depth + 1}")


def get_friendly_tool_name(tool_name: str) -> str:
    """Convert technical tool names to user-friendly descriptions"""
    friendly_names = {
        "list_directory": "listing files",
        "read_file": "reading file",
        "edit_file": "editing file",
        "search_and_replace": "modifying file",
        "search_files": "searching codebase",
        "run_terminal_command": "running command",
        "create_file": "creating file",
        "delete_file": "deleting file",
        "move_file": "moving file",
        "copy_file": "copying file",
        "get_git_status": "checking git status",
        "get_git_diff": "checking git changes",
        "commit_changes": "committing changes",
        "create_branch": "creating branch",
        "switch_branch": "switching branch",
        "merge_branch": "merging branch",
    }
    return friendly_names.get(tool_name, tool_name)


if __name__ == "__main__":
    # Run the FastAPI app with uvicorn
    uvicorn.run(
        app, host="0.0.0.0", port=5001
    )  # Different port for true streaming version
