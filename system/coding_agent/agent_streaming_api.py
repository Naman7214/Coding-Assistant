import asyncio
import json
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

import uvicorn
from agent_with_stream import AnthropicStreamingAgent
from config.settings import settings
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from models.schema.context_schema import (
    ActiveFileContext,
    RecentEditsContext,
    SystemInfo,
)
from models.schema.request_schema import (
    PermissionResponse,
    QueryRequest,
    StreamEvent,
)
from utils.context_formatter import (
    format_user_query,
    get_friendly_tool_name,
    truncate_to_words,
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
    open_files_context: Optional[List[Dict[str, Any]]] = None,
    recent_edits_context: Optional[RecentEditsContext] = None,
    context_mentions: Optional[List[str]] = None,
) -> AsyncGenerator[str, None]:
    """Stream the agent's response with enhanced context system"""
    global agent_instance

    # Check if agent is initialized
    if not agent_instance or not agent_instance.client:
        try:
            agent_instance = AnthropicStreamingAgent()
            server_url = settings.SERVER_URL
            transport_type = "sse"
            print(
                f"🔧 Initializing enhanced agent with workspace: {workspace_path}"
            )

            # Initialize agent with enhanced context system
            await agent_instance.initialize_session(
                server_url=server_url,
                transport_type=transport_type,
                workspace_path=workspace_path,
                hashed_workspace_path=hashed_workspace_path,
                git_branch=git_branch,
                system_info=system_info.model_dump() if system_info else None,
            )
        except Exception as e:
            yield create_stream_event(
                "error", f"Failed to initialize enhanced agent: {str(e)}"
            )
            return

    # Store workspace context for tool injection
    agent_instance.hashed_workspace_path = hashed_workspace_path
    agent_instance.git_branch = git_branch
    # Update agent with always-send context
    if system_info:
        agent_instance.set_system_info(system_info.model_dump())
    if active_file_context:
        print(f"Active File Context: {active_file_context}")
        agent_instance.set_active_file_context(
            active_file_context.model_dump() if active_file_context else None
        )
    if open_files_context:
        agent_instance.set_open_files_context(open_files_context)
    if recent_edits_context:
        agent_instance.set_recent_edits_context(recent_edits_context)
    if context_mentions:
        agent_instance.set_context_mentions(context_mentions)

    try:
        yield create_stream_event(
            "thinking",
            "Processing your request with enhanced context system...",
            {
                "query": query,
                "workspace": workspace_path,
                "context_mentions": context_mentions,
                "active_file": (
                    active_file_context.model_dump()
                    if active_file_context
                    else None
                ),
            },
        )

        # Update agent memory with enhanced context
        await agent_instance.update_context_memory()
        query = format_user_query(
            query,
            active_file_context,
            open_files_context,
            recent_edits_context,
            context_mentions,
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

        return StreamingResponse(
            stream_agent_response(
                request.query,
                request.workspace_path,
                request.hashed_workspace_path,
                request.git_branch,
                request.system_info,
                request.active_file_context,
                request.open_files_context,
                request.recent_edits_context,
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
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/permission")
async def handle_permission_response(response: PermissionResponse):
    """Handle permission response from frontend"""
    permission_id = response.permission_id
    granted = response.granted

    print(
        f"[PERMISSION] Received response: {permission_id}, granted: {granted}"
    )
    print(
        f"[PERMISSION] Current pending permissions: {list(pending_permissions.keys())}"
    )

    if permission_id in pending_permissions:
        future = pending_permissions[permission_id]
        if not future.done():
            future.set_result(granted)

        # Clean up the permission after processing
        pending_permissions.pop(permission_id, None)
        print(f"[PERMISSION] Cleaned up permission: {permission_id}")

        return {
            "status": "success",
            "message": f"Permission {'granted' if granted else 'denied'}",
        }
    else:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Permission request not found or expired",
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


@app.get("/")
async def root():
    return {
        "message": "Agent TRUE Streaming API with Enhanced Memory is running",
        "streaming": True,
    }


async def process_enhanced_streaming_tool_calls(
    depth=0, context_data=None
) -> AsyncGenerator[str, None]:
    """
    Enhanced process tool calls with context awareness and streaming
    """
    global agent_instance

    MAX_TOOL_CALL_DEPTH = settings.ANTHROPIC_MAX_TOOL_CALL_DEPTH

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

    # Track tool preparation state to prevent duplicate events
    tool_preparation_sent = {}  # Track which tools have sent preparation events

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
                # Tool input is being streamed - only send preparation event once per tool
                content_block_index = data.get("index", 0)

                # Only send the preparation event once per tool block
                if content_block_index not in tool_preparation_sent:
                    tool_preparation_sent[content_block_index] = True
                    print(
                        f"Enhanced: Tool preparation started for block {content_block_index}"
                    )
                    yield create_stream_event(
                        "tool_execution",
                        "Preparing tool arguments...",
                        {"status": "preparing"},
                    )
                # Note: We silently accumulate the JSON input without sending events for each delta

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
            print(f"[PERMISSION] Created permission request: {permission_id}")

            yield create_stream_event(
                "permission_request",
                f"Permission required to run command: {command}",
                {
                    "requires_permission": True,
                    "command": command,
                    "permission_id": permission_id,
                    "tool_name": tool_name,
                    "tool_use_id": tool_use_id,
                    "is_background": is_background,
                    "timeout_seconds": 60,
                    "friendly_name": friendly_name,
                },
            )

            try:
                # Wait for permission response with 3-minute timeout
                permission_granted = await asyncio.wait_for(
                    permission_future, timeout=180.0
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
                # Send permission timeout event to close UI modal
                yield create_stream_event(
                    "permission_timeout",
                    "Permission request timed out after 3 minutes",
                    {
                        "permission_id": permission_id,
                        "timeout": True,
                    },
                )

                yield create_stream_event(
                    "tool_result",
                    "Permission request timed out after 3 minutes. Command was not executed.",
                    {
                        "tool_name": tool_name,
                        "tool_use_id": tool_use_id,
                        "friendly_name": friendly_name,
                        "error": True,
                        "timeout": True,
                        "permission_denied": True,
                    },
                )
                agent_instance.agent_memory.add_tool_call(
                    tool_call, "Permission request timed out after 3 minutes"
                )
                agent_instance.agent_memory.add_tool_result(
                    tool_use_id,
                    "Permission request timed out after 3 minutes. Command was not executed.",
                )
                # Clean up pending permission only on timeout
                pending_permissions.pop(permission_id, None)
                continue

        # Handle permission for file deletion
        if tool_name == "delete_file":
            # Get the file path from tool input (could be 'target_file', 'file_path', or 'path')
            file_path = (
                tool_input.get("target_file")
                or tool_input.get("file_path")
                or tool_input.get("path", "unknown file")
            )
            permission_id = f"perm_{tool_use_id}_{int(time.time())}"

            permission_future = asyncio.Future()
            pending_permissions[permission_id] = permission_future
            print(
                f"[PERMISSION] Created delete file permission request: {permission_id}"
            )

            yield create_stream_event(
                "permission_request",
                f"Permission required to delete file: {file_path}",
                {
                    "requires_permission": True,
                    "file_path": file_path,
                    "permission_id": permission_id,
                    "tool_name": tool_name,
                    "tool_use_id": tool_use_id,
                    "timeout_seconds": 180,
                    "friendly_name": friendly_name,
                    "permission_type": "delete_file",
                },
            )

            try:
                # Wait for permission response with 3-minute timeout
                permission_granted = await asyncio.wait_for(
                    permission_future, timeout=180.0
                )

                if not permission_granted:
                    yield create_stream_event(
                        "tool_result",
                        "User denied to delete the file",
                        {
                            "tool_name": tool_name,
                            "tool_use_id": tool_use_id,
                            "friendly_name": friendly_name,
                            "error": True,
                            "permission_denied": True,
                        },
                    )
                    agent_instance.agent_memory.add_tool_call(
                        tool_call, "User denied to delete the file"
                    )
                    agent_instance.agent_memory.add_tool_result(
                        tool_use_id, "User denied to delete the file"
                    )
                    continue

                print(
                    f"Enhanced: Permission granted to delete file: {file_path}"
                )

            except asyncio.TimeoutError:
                # Send permission timeout event to close UI modal
                yield create_stream_event(
                    "permission_timeout",
                    "File deletion permission request timed out after 3 minutes",
                    {
                        "permission_id": permission_id,
                        "timeout": True,
                    },
                )

                yield create_stream_event(
                    "tool_result",
                    "File deletion permission request timed out after 3 minutes. File was not deleted.",
                    {
                        "tool_name": tool_name,
                        "tool_use_id": tool_use_id,
                        "friendly_name": friendly_name,
                        "error": True,
                        "timeout": True,
                        "permission_denied": True,
                    },
                )
                agent_instance.agent_memory.add_tool_call(
                    tool_call,
                    "File deletion permission request timed out after 3 minutes",
                )
                agent_instance.agent_memory.add_tool_result(
                    tool_use_id,
                    "File deletion permission request timed out after 3 minutes. File was not deleted.",
                )
                # Clean up pending permission only on timeout
                pending_permissions.pop(permission_id, None)
                continue

        # Enhanced tool execution with context injection
        try:
            if not agent_instance.client:
                raise Exception("Client is not initialized")

            # Enhanced workspace path injection for tools that need it (BEFORE tool call)
            tools_requiring_workspace_path = {
                "run_terminal_command",
                "search_and_replace",
                "search_files",
                "read_file",
                "delete_file",
                "grep_search",
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

            # Enhanced workspace context injection for codebase_search
            if tool_name == "codebase_search":
                if agent_instance.hashed_workspace_path:
                    if "hashed_workspace_path" not in tool_input:
                        tool_input["hashed_workspace_path"] = (
                            agent_instance.hashed_workspace_path
                        )
                        print(
                            f"✅ Enhanced: Injected hashed_workspace_path for {tool_name}"
                        )

                if agent_instance.git_branch:
                    if "git_branch" not in tool_input:
                        tool_input["git_branch"] = agent_instance.git_branch
                        print(
                            f"✅ Enhanced: Injected git_branch for {tool_name}"
                        )

            if tool_name == "list_directory" and agent_instance.workspace_path:
                if tool_input.get("dir_path") == ".":
                    tool_input["dir_path"] = agent_instance.workspace_path
                    print(f"✅ Enhanced: Updated dir_path for {tool_name}")

            tool_result = await agent_instance.client.call_tool(
                tool_name, tool_input
            )

            tool_result = truncate_to_words(str(tool_result))

            print(f"Enhanced: Tool input: {tool_input}")
            print(
                f"Enhanced: Received result from MCP server for tool: {tool_name}"
            )

            # Stream enhanced tool result
            yield create_stream_event(
                "tool_result",
                tool_result,
                {
                    "tool_name": tool_name,
                    "friendly_name": friendly_name,
                    "tool_use_id": tool_use_id,
                    "result_length": len(tool_result),
                },
            )

            # Record the tool call and result in agent memory
            agent_instance.agent_memory.add_tool_call(tool_call, tool_result)
            agent_instance.agent_memory.add_tool_result(
                tool_use_id, tool_result
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


if __name__ == "__main__":
    # Run the FastAPI app with uvicorn
    uvicorn.run(
        "agent_streaming_api:app", host="0.0.0.0", port=5001, reload=True
    )
