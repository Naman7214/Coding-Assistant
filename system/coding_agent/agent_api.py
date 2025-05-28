import asyncio
import json
import sys
import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from typing import Dict, Any, Optional
from pydantic import BaseModel

# Import the AnthropicAgent from the existing agent_with_cli.py
from agent_with_cli import AnthropicAgent

# Create FastAPI app
app = FastAPI(title="Agent API")

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

class QueryRequest(BaseModel):
    query: str
    target_file_path: Optional[str] = None
    workspace_path: str

class QueryResponse(BaseModel):
    response: str

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
        # Don't fail startup - we can retry later when a request comes in

@app.on_event("shutdown")
async def shutdown_event():
    global agent_instance
    if agent_instance:
        await agent_instance.cleanup()
        print("✅ Agent cleaned up successfully")

@app.post("/query", response_model=QueryResponse)
async def process_query(request: QueryRequest):
    global agent_instance
    
    # Check if agent is initialized
    if not agent_instance or not agent_instance.session:
        try:
            agent_instance = AnthropicAgent()
            server_url = os.environ.get("MCP_SERVER_URL", "http://localhost:8001/sse")
            transport_type = os.environ.get("MCP_TRANSPORT_TYPE", "sse")
            
            workspace_path = request.workspace_path
            await agent_instance.initialize_session(server_url, transport_type, workspace_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to initialize agent: {str(e)}")
        
    else:
        # Update workspace path if it's different from what's stored
        if request.workspace_path and request.workspace_path != agent_instance.workspace_path:
            agent_instance.workspace_path = request.workspace_path
            print(f"✅ Updated workspace path to: {request.workspace_path}")
    
    try:
        # Store the current number of tool calls to track only new ones in this session
        initial_tool_call_count = len(agent_instance.agent_memory.tool_calls_history)
        
        # Enhance the query with file path context if available
        enhanced_query = request.query
        if request.target_file_path:
            enhanced_query = f"Working with file: {request.target_file_path}\n\n{enhanced_query}"
        
        # Add the query to agent memory
        agent_instance.agent_memory.add_user_message(enhanced_query)
        
        # Call the API to get the initial response
        response = await agent_instance.anthropic_api_call(
            messages=agent_instance.agent_memory.get_conversation_messages(),
            tools=agent_instance.anthropic_tools,
        )
        
        if not response:
            return QueryResponse(response="I encountered an error and couldn't process your request.")
        
        # Process the message with tool calls
        assistant_message = {
            "role": "assistant",
            "content": response.get("content", []),
        }
        
        # Store edit_file code snippets from the initial response
        code_snippets = []
        
        # Check the initial response for edit_file tool calls
        if response.get("content"):
            print(json.dumps(response.get("content"), indent=4))
            for content_item in response.get("content", []):
                if content_item.get("type") == "tool_use" and content_item.get("name") == "edit_file":
                    tool_params = content_item.get("input", {})
                    code_snippet = tool_params.get("code_snippet")
                    target_file = tool_params.get("target_file_path")
                    
                    if code_snippet and target_file:
                        file_extension = target_file.split(".")[-1] if target_file else "js"
                        code_snippets.append({
                            "file_extension": file_extension,
                            "target_file": target_file,
                            "code_snippet": code_snippet
                        })
        
        # Process all tool calls
        result, updated_agent_memory = await agent_instance.process_tool_calls(assistant_message)
        
        # Update agent memory
        agent_instance.agent_memory = updated_agent_memory
        
        # Get the final response
        final_response = result["message"]
        
        # Only check for edit_file tool calls that were made during this query session
        # (between initial_tool_call_count and the current count)
        current_tool_calls = agent_instance.agent_memory.tool_calls_history[initial_tool_call_count:]
        
        for tool_call in current_tool_calls:
            if tool_call["tool"] == "edit_file":
                tool_arguments = tool_call.get("arguments", {})
                code_snippet = tool_arguments.get("code_snippet")
                target_file = tool_arguments.get("target_file_path")
                
                if code_snippet and target_file:
                    # Check if this is a new snippet we haven't seen before
                    is_new = True
                    for existing in code_snippets:
                        if existing["target_file"] == target_file and existing["code_snippet"] == code_snippet:
                            is_new = False
                            break
                            
                    if is_new:
                        file_extension = target_file.split(".")[-1] if target_file else "js"
                        code_snippets.append({
                            "file_extension": file_extension,
                            "target_file": target_file,
                            "code_snippet": code_snippet
                        })
        
        # Append code snippets to the final response
        for snippet in code_snippets:
            file_extension = snippet.get('file_extension', '')
            formatted_code = f"\n\n**Applied Code Changes:**\n\n```{file_extension}\n{snippet['code_snippet']}\n```"
            final_response += formatted_code
        
        # Return the response with code snippets included
        return QueryResponse(response=final_response)
        
    except Exception as e:
        print(f"Error processing query: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error processing query: {str(e)}")

@app.post("/health")
async def health_check():
    global agent_instance
    if agent_instance and agent_instance.session:
        return {"status": "healthy"}
    return {"status": "unhealthy"}

if __name__ == "__main__":
    # Run the FastAPI app with uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000) 