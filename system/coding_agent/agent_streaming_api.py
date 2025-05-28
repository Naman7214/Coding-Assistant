import asyncio
import json
import sys
import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn
from typing import Dict, Any, Optional, AsyncGenerator
from pydantic import BaseModel
import time

# Import the AnthropicAgent from the existing agent_with_cli.py
from agent_with_cli import AnthropicAgent

# Create FastAPI app
app = FastAPI(title="Agent Streaming API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store a global instance of the agent
agent_instance = None

# Store pending permission requests
pending_permissions = {}

class QueryRequest(BaseModel):
    query: str
    target_file_path: Optional[str] = None
    workspace_path: str

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
    agent_instance = AnthropicAgent()
    
    # Initialize the agent session with MCP server
    try:
        server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
        transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
        
        # Initialize the session but don't start the interactive loop
        await agent_instance.initialize_session(server_url, transport_type, "")
        print(f"✅ Agent initialized successfully with server: {server_url}")
    except Exception as e:
        print(f"❌ Failed to initialize agent: {e}")

@app.on_event("shutdown")
async def shutdown_event():
    global agent_instance
    if agent_instance:
        await agent_instance.cleanup()
        print("✅ Agent cleaned up successfully")

def create_stream_event(event_type: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> str:
    """Create a Server-Sent Event formatted string"""
    event = StreamEvent(
        type=event_type,
        content=content,
        metadata=metadata or {},
        timestamp=time.time()
    )
    return f"data: {event.json()}\n\n"

async def stream_agent_response(query: str, workspace_path: str, target_file_path: Optional[str] = None) -> AsyncGenerator[str, None]:
    """Stream the agent's response with incremental updates"""
    global agent_instance
    
    # Check if agent is initialized
    if not agent_instance or not agent_instance.session:
        try:
            agent_instance = AnthropicAgent()
            server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
            transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
            # Use workspace_path from request if available
            await agent_instance.initialize_session(server_url, transport_type, workspace_path)
        except Exception as e:
            yield create_stream_event("error", f"Failed to initialize agent: {str(e)}")
            return
    else:
        # Update workspace path if it's different from what's stored
        if workspace_path and workspace_path != agent_instance.workspace_path:
            agent_instance.workspace_path = workspace_path
            print(f"✅ Updated workspace path to: {workspace_path}")

    try:
        # Enhance the query with file path context if available
        enhanced_query = query
        if target_file_path:
            enhanced_query = f"Working with file: {target_file_path}\n\n{query}"
        
        yield create_stream_event("thinking", "Processing your request...", {"query": query})
        
        # Add the query to agent memory
        agent_instance.agent_memory.add_user_message(enhanced_query)
        
        # Call the API to get the initial response
        yield create_stream_event("thinking", "Generating response...")
        
        response = await agent_instance.anthropic_api_call(
            messages=agent_instance.agent_memory.get_conversation_messages(),
            tools=agent_instance.anthropic_tools,
        )
        
        if not response:
            yield create_stream_event("error", "I encountered an error and couldn't process your request.")
            return
        
        # Process the message with tool calls using our streaming version
        assistant_message = {
            "role": "assistant",
            "content": response.get("content", []),
        }
        
        # Stream the processing of tool calls
        async for event in stream_process_tool_calls(assistant_message):
            yield event
            
    except Exception as e:
        print(f"Error processing query: {str(e)}")
        import traceback
        traceback.print_exc()
        yield create_stream_event("error", f"Error processing query: {str(e)}")

async def stream_process_tool_calls(assistant_message: Dict[str, Any], depth: int = 0) -> AsyncGenerator[str, None]:
    """Stream the processing of tool calls with incremental updates"""
    global agent_instance
    
    if depth >= agent_instance.MAX_TOOL_CALL_DEPTH:
        yield create_stream_event("error", "Maximum tool call depth reached. Stopping to prevent infinite loops.")
        return
    
    # Extract content blocks from Anthropic response
    content_blocks = assistant_message.get("content", [])
    has_tool_calls = False
    tool_calls = []
    
    # Check for tool_use blocks in the content
    for block in content_blocks:
        if block.get("type") == "tool_use":
            has_tool_calls = True
            tool_calls.append(block)
    
    # If no tool calls, just return the text response
    if not has_tool_calls:
        # Extract text from content blocks
        text_content = ""
        thinking_text = None
        
        for block in content_blocks:
            if block.get("type") == "thinking" and (
                block.get("thinking") or block.get("text") or block.get("content")
            ):
                thinking_text = (
                    block.get("thinking") or block.get("text") or block.get("content")
                )
            if block.get("type") == "text":
                text_content += block.get("text", "")
        
        # Stream thinking if present
        if thinking_text:
            yield create_stream_event("thinking", str(thinking_text))
        
        # Stream the final response
        yield create_stream_event("assistant_response", text_content)
        
        # Add the assistant's final response to memory
        agent_instance.agent_memory.add_assistant_message(assistant_message)
        
        yield create_stream_event("final_response", text_content)
        return
    
    # Add the assistant message with tool calls to memory
    agent_instance.agent_memory.add_assistant_message(assistant_message)
    
    # Stream each tool call
    for tool_call in tool_calls:
        tool_use_id = tool_call.get("id")
        tool_name = tool_call.get("name")
        tool_input = tool_call.get("input", {})
        
        print(f"🔍 DEBUG: Processing tool call - Name: {tool_name}, ID: {tool_use_id}")
        print(f"🔍 DEBUG: Tool input: {tool_input}")
        
        # Inject workspace_path for tools that require it
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
        
        # Stream tool selection
        yield create_stream_event(
            "tool_selection", 
            f"Selected tool: {tool_name}",
            {
                "tool_name": tool_name,
                "tool_arguments": tool_input,
                "tool_use_id": tool_use_id
            }
        )
        
        # Check for permission if needed (simplified for streaming)
        print(f"🔍 DEBUG: Checking tool name: '{tool_name}' against 'run_terminal_command'")
        if tool_name == "run_terminal_command":
            print(f"🔍 DEBUG: Permission check triggered for tool: {tool_name}")
            command = tool_input.get("command", "")
            permission_id = f"perm_{tool_use_id}_{int(time.time())}"
            
            print(f"🔍 DEBUG: Command to execute: {command}")
            print(f"🔍 DEBUG: Permission ID: {permission_id}")
            
            # Create a future to wait for permission response
            permission_future = asyncio.Future()
            pending_permissions[permission_id] = permission_future
            
            print(f"🔍 DEBUG: Sending permission_request event")
            yield create_stream_event(
                "permission_request",
                f"Permission required to run command: {command}",
                {
                    "requires_permission": True, 
                    "command": command,
                    "permission_id": permission_id,
                    "tool_name": tool_name
                }
            )
            
            try:
                print(f"🔍 DEBUG: Waiting for permission response...")
                # Wait for permission response (with timeout)
                permission_granted = await asyncio.wait_for(permission_future, timeout=60.0)
                
                print(f"🔍 DEBUG: Permission response received: {permission_granted}")
                
                if not permission_granted:
                    print(f"🔍 DEBUG: Permission denied, skipping tool execution")
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
                    # Record the denial in memory
                    agent_instance.agent_memory.add_tool_call(tool_call, "Permission denied by user")
                    agent_instance.agent_memory.add_tool_result(tool_use_id, "Permission denied by user")
                    continue  # Skip to next tool call
                    
            except asyncio.TimeoutError:
                print(f"🔍 DEBUG: Permission request timed out")
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
                # Record the timeout in memory
                agent_instance.agent_memory.add_tool_call(tool_call, "Permission request timed out")
                agent_instance.agent_memory.add_tool_result(tool_use_id, "Permission request timed out")
                continue  # Skip to next tool call
            finally:
                # Clean up the pending permission
                pending_permissions.pop(permission_id, None)
        else:
            print(f"🔍 DEBUG: No permission check needed for tool: {tool_name}")
        
        # Stream tool execution start
        yield create_stream_event(
            "tool_execution",
            f"Executing {tool_name}...",
            {"tool_name": tool_name, "status": "executing"}
        )
        
        # Call the MCP tool
        try:
            if not agent_instance.session:
                raise Exception("Session is not initialized")
            
            tool_result = await agent_instance.session.call_tool(tool_name, tool_input)
            
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
            
            # Still record the attempt in memory
            agent_instance.agent_memory.add_tool_call(tool_call, f"ERROR: {str(e)}")
            agent_instance.agent_memory.add_tool_result(tool_use_id, error_message)
    
    # Make next call to Anthropic with tool results
    yield create_stream_event("thinking", f"Generating response after tool calls (depth {depth})...")
    
    next_response = await agent_instance.anthropic_api_call(
        messages=agent_instance.agent_memory.get_conversation_messages(),
        tools=agent_instance.anthropic_tools,
    )
    
    if not next_response:
        final_message = {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "Error: Couldn't get a response from the LLM after tool calls.",
                }
            ],
        }
        agent_instance.agent_memory.add_assistant_message(final_message)
        yield create_stream_event("error", "Couldn't get a response from the LLM after tool calls.")
        return
    
    next_assistant_message = {
        "role": "assistant",
        "content": next_response.get("content", []),
    }
    
    # Check if this message has more tool calls
    has_more_tool_calls = any(
        block.get("type") == "tool_use"
        for block in next_response.get("content", [])
    )
    
    if has_more_tool_calls:
        yield create_stream_event("thinking", f"Making additional tool calls (depth {depth + 1})...")
        async for event in stream_process_tool_calls(next_assistant_message, depth + 1):
            yield event
    else:
        # If we get here, the LLM provided a final response with no more tool calls
        agent_instance.agent_memory.add_assistant_message(next_assistant_message)
        
        # Extract text from content blocks for the final response
        final_response = ""
        for block in next_response.get("content", []):
            if block.get("type") == "text":
                final_response += block.get("text", "")
        
        yield create_stream_event("assistant_response", final_response)
        yield create_stream_event("final_response", final_response)

@app.post("/stream")
async def stream_query(request: QueryRequest):
    """Stream the agent's response with incremental updates"""
    return StreamingResponse(
        stream_agent_response(request.query, request.workspace_path, request.target_file_path),
        media_type="text/plain",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream",
        }
    )

@app.post("/permission")
async def handle_permission_response(response: PermissionResponse):
    """Handle permission response from frontend"""
    permission_id = response.permission_id
    granted = response.granted
    
    print(f"🔍 DEBUG: Received permission response - ID: {permission_id}, Granted: {granted}")
    print(f"🔍 DEBUG: Pending permissions: {list(pending_permissions.keys())}")
    
    if permission_id in pending_permissions:
        # Resolve the future with the permission result
        future = pending_permissions[permission_id]
        if not future.done():
            print(f"🔍 DEBUG: Resolving future with result: {granted}")
            future.set_result(granted)
        else:
            print(f"🔍 DEBUG: Future was already resolved")
        return {"status": "success", "message": f"Permission {'granted' if granted else 'denied'}"}
    else:
        print(f"🔍 DEBUG: Permission ID not found in pending permissions")
        raise HTTPException(status_code=404, detail="Permission request not found or expired")

@app.post("/health")
async def health_check():
    global agent_instance
    if agent_instance and agent_instance.session:
        return {"status": "healthy"}
    return {"status": "unhealthy"}

@app.get("/")
async def root():
    return {"message": "Agent Streaming API is running"}

if __name__ == "__main__":
    # Run the FastAPI app with uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5001)  # Different port from original API 