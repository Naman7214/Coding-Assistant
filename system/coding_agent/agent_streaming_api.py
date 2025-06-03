import asyncio
import json
import sys
import os
import uuid
import subprocess
import shlex
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn
from typing import Dict, Any, Optional, AsyncGenerator, List
from pydantic import BaseModel
import time

# Import the AnthropicStreamingAgent from the new streaming agent
from agent_with_cli_stream import AnthropicStreamingAgent

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

# Store active terminal processes
active_terminal_processes = {}

class SystemInfo(BaseModel):
    platform: str
    osVersion: str
    architecture: str
    workspacePath: str
    defaultShell: str
    nodeVersion: str
    vsCodeVersion: str
    extensionVersion: str
    environmentVariables: Dict[str, str]
    workspaceName: Optional[str] = None
    workspaceFolders: List[str]

class QueryRequest(BaseModel):
    query: str
    target_file_path: Optional[str] = None
    workspace_path: str
    system_info: Optional[SystemInfo] = None

class PermissionResponse(BaseModel):
    permission_id: str
    granted: bool

class StreamEvent(BaseModel):
    type: str  # "thinking", "assistant_response", "tool_selection", "tool_execution", "tool_result", "final_response", "permission_request"
    content: str
    metadata: Optional[Dict[str, Any]] = None
    timestamp: float

@app.on_event("startup")
async def startup_event():
    global agent_instance
    agent_instance = AnthropicStreamingAgent()
    
    # Don't initialize the session here with blank system info
    # The session will be initialized with proper system info when the first request comes in
    print(f"✅ Streaming Agent instance created successfully")

@app.on_event("shutdown")
async def shutdown_event():
    global agent_instance
    if agent_instance:
        await agent_instance.cleanup()
        print("✅ Streaming Agent cleaned up successfully")

def create_stream_event(event_type: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> str:
    """Create a Server-Sent Event formatted string"""
    event = StreamEvent(
        type=event_type,
        content=content,
        metadata=metadata or {},
        timestamp=time.time()
    )
    return f"data: {event.json()}\n\n"

async def stream_agent_response(query: str, workspace_path: str, target_file_path: Optional[str] = None, system_info: Optional[SystemInfo] = None) -> AsyncGenerator[str, None]:
    """Stream the agent's response with TRUE real-time streaming"""
    global agent_instance
    
    print(f"🚀 Stream request received:")
    print(f"   Query: {query[:100]}...")
    print(f"   Workspace Path: {workspace_path}")
    print(f"   Target File: {target_file_path}")
    if system_info:
        print(f"   System: {system_info.platform} {system_info.osVersion}")
        print(f"   Shell: {system_info.defaultShell}")
        print(f"   VS Code: {system_info.vsCodeVersion}")
    
    # Check if agent is initialized
    if not agent_instance or not agent_instance.session:
        try:
            agent_instance = AnthropicStreamingAgent()
            server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
            transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
            print(f"🔧 Initializing new agent with workspace: {workspace_path}")
            
            # Convert SystemInfo to dict if provided
            system_info_dict = system_info.dict() if system_info else None
            
            await agent_instance.initialize_session(server_url, transport_type, workspace_path, system_info_dict)
        except Exception as e:
            yield create_stream_event("error", f"Failed to initialize streaming agent: {str(e)}")
            return
    
    else:
        # Update workspace path and system info if they're different
        workspace_changed = workspace_path and workspace_path != agent_instance.workspace_path
        system_info_changed = system_info and system_info.dict() != agent_instance.system_info
        
        if workspace_changed:
            agent_instance.workspace_path = workspace_path
            print(f"✅ Updated workspace path to: {workspace_path}")
        
        if system_info_changed and system_info:
            agent_instance.set_system_info(system_info.dict())
            print(f"✅ Updated system info")
        
        # If workspace or system info changed, regenerate the system prompt
        if workspace_changed or system_info_changed:
            try:
                # Get available tools to recreate the system prompt
                if agent_instance.session:
                    tools = await agent_instance.session.list_tools()
                    if tools and hasattr(tools, "tools") and tools.tools:
                        # Import the system prompt here to avoid circular imports
                        from prompts.coding_agent_prompt import CODING_AGENT_SYSTEM_PROMPT
                        

                        
                        # Format system info context
                        system_info_context = agent_instance._format_system_info_context()
                        
                        # Create new system message with updated info
                        system_message = CODING_AGENT_SYSTEM_PROMPT.format(
                            system_info_context=system_info_context,
                        )
                        
                        # Reinitialize agent memory with new system message
                        agent_instance.agent_memory.initialize_with_system_message(system_message)
                        print(f"✅ Regenerated system prompt with updated workspace and system info")
                        
            except Exception as e:
                print(f"⚠️ Warning: Could not regenerate system prompt: {e}")
                # Continue without regenerating - this is not critical for basic functionality
    
    try:
        # Enhance the query with file path context if available
        enhanced_query = query
        if target_file_path:
            enhanced_query = f"Working with file: {target_file_path}\n\n{query}"
        
        yield create_stream_event("thinking", "Processing your request...", {
            "query": query, 
            "workspace": workspace_path,
            "system_info": system_info.dict() if system_info else None
        })
        
        # Add the query to agent memory
        agent_instance.agent_memory.add_user_message(enhanced_query)
        
        # Use the same approach as the CLI version - process streaming tool calls
        yield create_stream_event("thinking", "Generating response with real-time streaming...")
        
        # Process with streaming tool calls using the working method
        async for event in process_streaming_tool_calls_fixed(depth=0):
            yield event
                
    except Exception as e:
        print(f"Error processing query: {str(e)}")
        import traceback
        traceback.print_exc()
        
        # If we encounter an error about duplicate tool IDs, reset the agent
        if "tool_use` ids must be unique" in str(e):
            yield create_stream_event("error", f"Conversation history error detected. Resetting agent...")
            await reset_agent()
            yield create_stream_event("error", f"Agent reset complete. Please try your query again.")
        else:
            yield create_stream_event("error", f"Error processing query: {str(e)}")

async def reset_agent():
    """Reset the agent completely when conversation errors occur"""
    global agent_instance
    
    # Store the current workspace path and system info before cleanup
    current_workspace_path = agent_instance.workspace_path if agent_instance else None
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
        server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
        transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
        # Use the preserved workspace path and system info
        success = await agent_instance.initialize_session(server_url, transport_type, current_workspace_path, current_system_info)
        if success:
            print("✅ Agent reset successfully with preserved system info")
        else:
            print("❌ Failed to reset agent")
    except Exception as e:
        print(f"❌ Error creating new agent instance: {e}")
        agent_instance = None

async def process_streaming_tool_calls_fixed(depth=0):
    """
    Process tool calls with streaming, using the same approach as the working CLI version
    """
    global agent_instance, active_terminal_processes
    
    MAX_TOOL_CALL_DEPTH = 100
    
    if depth >= MAX_TOOL_CALL_DEPTH:
        yield create_stream_event("error", "Maximum tool call depth reached. Stopping to prevent infinite loops.")
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
    
    yield create_stream_event("thinking", f"Generating response (depth {depth})...")

    async for stream_event in agent_instance.anthropic_streaming_api_call(
        messages=agent_instance.agent_memory.get_conversation_messages(),
        tools=agent_instance.anthropic_tools,
    ):
        event_type = stream_event.get("type")
        data = stream_event.get("data", {})
        
        if event_type == "content_block_start":
            content_block = data.get("content_block", {})
            if content_block.get("type") == "thinking":
                yield create_stream_event("thinking", "Assistant is reasoning...")
            elif content_block.get("type") == "text":
                yield create_stream_event("assistant_response", "")
            elif content_block.get("type") == "tool_use":
                tool_name = content_block.get("name", "unknown")
                yield create_stream_event("tool_selection", f"Selected tool: {tool_name}", {
                    "tool_name": tool_name
                })
        
        elif event_type == "content_block_delta":
            delta = data.get("delta", {})
            if delta.get("type") == "thinking_delta":
                thinking_text = delta.get("thinking", "")
                thinking_content += thinking_text
                if thinking_text:
                    yield create_stream_event("thinking", thinking_text)
            elif delta.get("type") == "text_delta":
                text_chunk = delta.get("text", "")
                text_content += text_chunk
                if text_chunk:
                    yield create_stream_event("assistant_response", text_chunk)
            elif delta.get("type") == "input_json_delta":
                # Tool input is being streamed
                yield create_stream_event("tool_execution", ".", {"status": "building_input"})
        
        elif event_type == "content_block_stop":
            # Content block ended
            pass
        
        elif event_type == "message_stop":
            complete_message = stream_event.get("complete_message")
            print(f"Received message_stop at depth {depth}, complete_message: {complete_message is not None}")  # Debug logging
            if complete_message:
                print(f"Complete message content blocks: {len(complete_message.get('content', []))}")  # Debug logging
            else:
                print(f"Stream event keys: {list(stream_event.keys())}")  # Debug logging
                print(f"Full stream event: {stream_event}")  # Debug logging
            break
    
    if not complete_message:
        print(f"No complete message at depth {depth}, yielding error")  # Debug logging
        # If this is a recursive call (depth > 0) and we have no complete message,
        # it might mean the LLM has nothing more to say after tool execution
        if depth > 0:
            print(f"Depth > 0, treating as successful completion")  # Debug logging
            yield create_stream_event("final_response", "Task completed successfully.")
            return
        else:
            yield create_stream_event("error", "Couldn't get a complete response from the LLM.")
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
        print(f"No tool calls at depth {depth}, text_content length: {len(text_content)}")  # Debug logging
        # Add the assistant's final response to memory
        agent_instance.agent_memory.add_assistant_message(assistant_message)
        if text_content:
            yield create_stream_event("final_response", text_content)
        else:
            # If no text content, send a generic completion message
            yield create_stream_event("final_response", "Task completed successfully.")
        return

    # Add the assistant message with tool calls to memory
    agent_instance.agent_memory.add_assistant_message(assistant_message)

    # Process each tool call
    for tool_call in tool_calls:
        tool_use_id = tool_call.get("id")
        tool_name = tool_call.get("name")
        tool_input = tool_call.get("input", {})

        yield create_stream_event(
            "tool_execution",
            f"Executing {tool_name}...",
            {
                "tool_name": tool_name, 
                "tool_arguments": tool_input,
                "tool_use_id": tool_use_id,
                "status": "executing"
            }
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
                    "is_background": is_background
                }
            )
            
            try:
                permission_granted = await asyncio.wait_for(permission_future, timeout=60.0)
                
                if not permission_granted:
                    yield create_stream_event(
                        "tool_result",
                        "Permission denied by user",
                        {
                            "tool_name": tool_name,
                            "tool_use_id": tool_use_id,
                            "error": True,
                            "permission_denied": True
                        }
                    )
                    agent_instance.agent_memory.add_tool_call(tool_call, "Permission denied by user")
                    agent_instance.agent_memory.add_tool_result(tool_use_id, "Permission denied by user")
                    continue
                
                # Permission granted, now execute the tool through MCP server like other tools
                print(f"Permission granted for command: {command}, sending to MCP server")
                    
            except asyncio.TimeoutError:
                yield create_stream_event(
                    "tool_result",
                    "Permission request timed out",
                    {
                        "tool_name": tool_name,
                        "tool_use_id": tool_use_id,
                        "error": True,
                        "timeout": True
                    }
                )
                agent_instance.agent_memory.add_tool_call(tool_call, "Permission request timed out")
                agent_instance.agent_memory.add_tool_result(tool_use_id, "Permission request timed out")
                continue
            finally:
                pending_permissions.pop(permission_id, None)

        # Execute the tool (including run_terminal_command after permission is granted)
        try:
            if not agent_instance.session:
                raise Exception("Session is not initialized")
            
            tools_requiring_workspace_path = {
                "run_terminal_command", 
                "search_and_replace", 
                "search_files"
            }
            
            if tool_name in tools_requiring_workspace_path and agent_instance.workspace_path:
                # Only add workspace_path if it's not already in the tool_input
                if "workspace_path" not in tool_input:
                    tool_input["workspace_path"] = agent_instance.workspace_path
                    print(f"✅ Injected workspace_path for {tool_name}: {agent_instance.workspace_path}")
                    
            if tool_name == "list_directory" and agent_instance.workspace_path:
                if tool_input.get("dir_path") == ".":
                    tool_input["dir_path"] = agent_instance.workspace_path
                    print(f"✅ Updated dir_path for {tool_name} from '.' to: {agent_instance.workspace_path}")
            
            print(f"Calling MCP server for tool: {tool_name}")  # Debug logging
            tool_result = await agent_instance.session.call_tool(tool_name, tool_input)
            print(f"Received result from MCP server for tool: {tool_name}")  # Debug logging
            
            if tool_result:
                tool_content = "\n".join([
                    (content.text if hasattr(content, "text") else str(content))
                    for content in tool_result
                ])
                
                # Limit content length for streaming
                original_length = len(tool_content)
                if original_length > 8000:
                    tool_content = tool_content[:8000] + f"\n[Content truncated from {original_length} to 8000 characters]"
            else:
                tool_content = "No result from tool"

            # Stream tool result
            yield create_stream_event(
                "tool_result",
                tool_content,
                {
                    "tool_name": tool_name,
                    "tool_use_id": tool_use_id,
                    "result_length": len(tool_content),
                    "truncated": original_length > 8000 if 'original_length' in locals() else False
                }
            )

            # Record the tool call and result in agent memory
            agent_instance.agent_memory.add_tool_call(tool_call, tool_content)
            agent_instance.agent_memory.add_tool_result(tool_use_id, tool_content)

        except Exception as e:
            error_message = f"Error calling tool {tool_name}: {str(e)}"
            yield create_stream_event(
                "tool_result",
                error_message,
                {
                    "tool_name": tool_name,
                    "tool_use_id": tool_use_id,
                    "error": True
                }
            )
            agent_instance.agent_memory.add_tool_call(tool_call, f"ERROR: {str(e)}")
            agent_instance.agent_memory.add_tool_result(tool_use_id, error_message)

    # Make next call to Anthropic with tool results (recursive call)
    print(f"Making recursive call with depth {depth + 1}")  # Debug logging
    
    # Debug: Check conversation messages before recursive call
    conversation_messages = agent_instance.agent_memory.get_conversation_messages()
    print(f"Conversation messages for recursive call: {len(conversation_messages)} messages")  # Debug logging
    for i, msg in enumerate(conversation_messages[-3:]):  # Show last 3 messages
        print(f"Message {i}: role={msg.get('role')}, content_blocks={len(msg.get('content', []))}")  # Debug logging
    
    has_final_response = False
    async for event in process_streaming_tool_calls_fixed(depth + 1):
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
        print(f"No final response received at depth {depth + 1}, sending completion")  # Debug logging
        yield create_stream_event("final_response", "All tasks completed successfully.")
    
    print(f"Completed recursive call with depth {depth + 1}")  # Debug logging

@app.post("/stream")
async def stream_query(request: QueryRequest):
    """Stream the agent's response to a query"""
    try:
        return StreamingResponse(
            stream_agent_response(
                request.query, 
                request.workspace_path, 
                request.target_file_path,
                request.system_info
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
            }
        )
    except Exception as e:
        print(f"Error in stream_query: {str(e)}")
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
        return {"status": "success", "message": f"Permission {'granted' if granted else 'denied'}"}
    else:
        raise HTTPException(status_code=404, detail="Permission request not found or expired")

@app.post("/health")
async def health_check():
    global agent_instance
    if agent_instance and agent_instance.session:
        return {"status": "healthy", "streaming": True}
    return {"status": "unhealthy", "streaming": False}

@app.post("/reset")
async def reset_agent_endpoint():
    """API endpoint to reset the agent in case of errors"""
    try:
        await reset_agent()
        return {"status": "success", "message": "Agent reset successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to reset agent: {str(e)}")

@app.post("/sanitize")
async def sanitize_conversation():
    """API endpoint to sanitize the conversation history to remove duplicate tool IDs"""
    global agent_instance
    if not agent_instance:
        raise HTTPException(status_code=400, detail="Agent not initialized")
    
    try:
        original_length = len(agent_instance.agent_memory.full_history)
        fixed = sanitize_conversation_history(agent_instance.agent_memory.full_history)
        agent_instance.agent_memory.full_history = fixed
        return {
            "status": "success", 
            "message": f"Conversation sanitized. Original length: {original_length}, New length: {len(fixed)}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to sanitize conversation: {str(e)}")

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
                        print(f"Fixing duplicate tool ID: {tool_id} -> {new_id}")
                        block = block.copy()  # Create a copy to avoid modifying the original
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

@app.post("/terminate_process")
async def terminate_process(request: Request):
    """Terminate a running terminal process"""
    data = await request.json()
    process_id = data.get("process_id")
    
    if not process_id or process_id not in active_terminal_processes:
        raise HTTPException(status_code=404, detail="Process not found")
    
    try:
        process = active_terminal_processes[process_id]
        process.terminate()  # Send SIGTERM
        
        # Wait a bit and kill if it doesn't terminate
        try:
            await asyncio.wait_for(process.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            process.kill()  # Force kill with SIGKILL
        
        active_terminal_processes.pop(process_id, None)
        
        return {"status": "success", "message": "Process terminated"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to terminate process: {str(e)}")

@app.get("/")
async def root():
    return {"message": "Agent TRUE Streaming API is running", "streaming": True}

if __name__ == "__main__":
    # Run the FastAPI app with uvicorn
    #192.168.17.182
    uvicorn.run(app, host="0.0.0.0", port=5001)  # Different port for true streaming version 