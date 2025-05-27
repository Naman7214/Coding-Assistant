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

class QueryRequest(BaseModel):
    query: str
    target_file_path: Optional[str] = None

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
    
    # Initialize the agent session with MCP server
    try:
        server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
        transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
        
        # Initialize the session but don't start the interactive loop
        await agent_instance.initialize_session(server_url, transport_type)
        print(f"✅ Streaming Agent initialized successfully with server: {server_url}")
    except Exception as e:
        print(f"❌ Failed to initialize streaming agent: {e}")

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

async def stream_agent_response(query: str, target_file_path: Optional[str] = None) -> AsyncGenerator[str, None]:
    """Stream the agent's response with TRUE real-time streaming"""
    global agent_instance
    
    # Check if agent is initialized
    if not agent_instance or not agent_instance.session:
        try:
            agent_instance = AnthropicStreamingAgent()
            server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
            transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
            await agent_instance.initialize_session(server_url, transport_type)
        except Exception as e:
            yield create_stream_event("error", f"Failed to initialize streaming agent: {str(e)}")
            return
    
    try:
        # Enhance the query with file path context if available
        enhanced_query = query
        if target_file_path:
            enhanced_query = f"Working with file: {target_file_path}\n\n{query}"
        
        yield create_stream_event("thinking", "Processing your request...", {"query": query})
        
        # Add the query to agent memory
        agent_instance.agent_memory.add_user_message(enhanced_query)
        
        # Use the TRUE streaming method that streams tokens in real-time
        yield create_stream_event("thinking", "Generating response with real-time streaming...")
        
        # Stream the processing with TRUE streaming
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
                    if thinking_text:
                        yield create_stream_event("thinking", thinking_text)
                elif delta.get("type") == "text_delta":
                    text_chunk = delta.get("text", "")
                    if text_chunk:
                        yield create_stream_event("assistant_response", text_chunk)
            
            elif event_type == "message_stop":
                # Get the complete message and process any tool calls
                complete_message = stream_event.get("complete_message")
                if complete_message:
                    # Check for tool calls and process them
                    content_blocks = complete_message.get("content", [])
                    tool_calls = [block for block in content_blocks if block.get("type") == "tool_use"]
                    
                    if tool_calls:
                        # Process tool calls
                        assistant_message = {
                            "role": "assistant",
                            "content": content_blocks,
                        }
                        agent_instance.agent_memory.add_assistant_message(assistant_message)
                        
                        # Execute tools and continue streaming
                        async for tool_event in process_tool_calls_streaming(tool_calls):
                            yield tool_event
                    else:
                        # No tool calls, just final response
                        text_content = ""
                        for block in content_blocks:
                            if block.get("type") == "text":
                                text_content += block.get("text", "")
                        
                        if text_content:
                            yield create_stream_event("final_response", text_content)
                        
                        # Add to memory
                        assistant_message = {
                            "role": "assistant", 
                            "content": content_blocks
                        }
                        agent_instance.agent_memory.add_assistant_message(assistant_message)
                break
            
            elif event_type == "error":
                yield create_stream_event("error", f"Streaming error: {data.get('error', 'Unknown error')}")
                return
                
    except Exception as e:
        print(f"Error processing query: {str(e)}")
        import traceback
        traceback.print_exc()
        yield create_stream_event("error", f"Error processing query: {str(e)}")

async def process_tool_calls_streaming(tool_calls) -> AsyncGenerator[str, None]:
    """Process tool calls with streaming updates"""
    global agent_instance
    
    for tool_call in tool_calls:
        tool_use_id = tool_call.get("id")
        tool_name = tool_call.get("name")
        tool_input = tool_call.get("input", {})
        
        # Stream tool execution start
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
                    "tool_name": tool_name
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
        
        # Execute the tool
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
            
            # Record in memory
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
    
    # After all tools are executed, get the next response
    yield create_stream_event("thinking", "Generating final response after tool execution...")
    
    # Stream the next response
    async for stream_event in agent_instance.anthropic_streaming_api_call(
        messages=agent_instance.agent_memory.get_conversation_messages(),
        tools=agent_instance.anthropic_tools,
    ):
        event_type = stream_event.get("type")
        data = stream_event.get("data", {})
        
        if event_type == "content_block_delta":
            delta = data.get("delta", {})
            if delta.get("type") == "text_delta":
                text_chunk = delta.get("text", "")
                if text_chunk:
                    yield create_stream_event("assistant_response", text_chunk)
        
        elif event_type == "message_stop":
            complete_message = stream_event.get("complete_message")
            if complete_message:
                # Extract final text
                text_content = ""
                for block in complete_message.get("content", []):
                    if block.get("type") == "text":
                        text_content += block.get("text", "")
                
                if text_content:
                    yield create_stream_event("final_response", text_content)
                
                # Add to memory
                assistant_message = {
                    "role": "assistant",
                    "content": complete_message.get("content", [])
                }
                agent_instance.agent_memory.add_assistant_message(assistant_message)
            break

@app.post("/stream")
async def stream_query(request: QueryRequest):
    """Stream the agent's response with TRUE real-time streaming"""
    return StreamingResponse(
        stream_agent_response(request.query, request.target_file_path),
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

@app.get("/")
async def root():
    return {"message": "Agent TRUE Streaming API is running", "streaming": True}

if __name__ == "__main__":
    # Run the FastAPI app with uvicorn
    uvicorn.run(app, host="192.168.17.182", port=5001)  # Different port for true streaming version 