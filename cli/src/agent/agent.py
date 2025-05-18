"""
Agent implementation for the Code Generation Assistant.
This module implements the logic to process natural language instructions
and execute the appropriate tools.
"""
from typing import Dict, List, Any, Optional
import json
import os
from pydantic import BaseModel, Field

from .tools import AVAILABLE_TOOLS

class ToolCall(BaseModel):
    """Model for a tool call request"""
    tool: str = Field(..., description="Name of the tool to call")
    parameters: Dict[str, Any] = Field(default_factory=dict, description="Parameters for the tool")


class AgentResponse(BaseModel):
    """Model for an agent response"""
    message: str = Field(..., description="Response message from the agent")
    tool_calls: List[Dict[str, Any]] = Field(default_factory=list, description="List of tool calls made")
    tool_results: List[Dict[str, Any]] = Field(default_factory=list, description="Results from tool calls")


class Agent:
    """Agent for Code Generation Assistant"""
    
    def __init__(self, api_key: Optional[str] = None, model: str = "gpt-3.5-turbo"):
        """Initialize the agent.
        
        Args:
            api_key: OpenAI API key (optional, will use OPENAI_API_KEY env var if not provided)
            model: Model to use for AI completions
        """
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self.model = model
        self.tools = AVAILABLE_TOOLS
        self.history = []
        
        # For the prototype, we'll use a simple rule-based approach
        # In a real implementation, we would use LangChain or a similar framework
        
    def _rule_based_dispatch(self, query: str) -> List[ToolCall]:
        """Simple rule-based dispatch for the prototype"""
        tool_calls = []
        
        # Look for common patterns in the query
        query_lower = query.lower()
        
        if "search" in query_lower and "code" in query_lower:
            # Code search request
            search_term = query.split("search")[-1].strip()
            tool_calls.append(ToolCall(
                tool="codebase_search",
                parameters={"query": search_term}
            ))
        
        elif "read" in query_lower and "file" in query_lower:
            # File reading request
            file_mention = [word for word in query.split() if "." in word]
            if file_mention:
                tool_calls.append(ToolCall(
                    tool="read_file",
                    parameters={"target_file": file_mention[0]}
                ))
        
        elif "list" in query_lower and ("directory" in query_lower or "folder" in query_lower or "dir" in query_lower):
            # List directory request
            path = "."  # Default to current directory
            if "in" in query_lower:
                path_parts = query_lower.split("in")
                if len(path_parts) > 1:
                    path_candidates = path_parts[1].strip().split()
                    if path_candidates:
                        path = path_candidates[0]
            
            tool_calls.append(ToolCall(
                tool="list_dir",
                parameters={"path": path}
            ))
        
        elif "run" in query_lower or "execute" in query_lower:
            # Command execution request
            command = query.split("run")[-1].strip() if "run" in query_lower else query.split("execute")[-1].strip()
            tool_calls.append(ToolCall(
                tool="run_terminal_cmd",
                parameters={"command": command}
            ))
        
        elif "create" in query_lower or "edit" in query_lower:
            # File creation/editing request
            # This is a simplified approach - in a real system we'd need more sophisticated parsing
            file_mention = [word for word in query.split() if "." in word]
            if file_mention:
                tool_calls.append(ToolCall(
                    tool="edit_file",
                    parameters={
                        "target_file": file_mention[0],
                        "content": "",  # Placeholder - in a real system we'd generate content
                        "mode": "write"
                    }
                ))
        
        # If no specific tools were called, default to a message response
        if not tool_calls:
            # In a real system, this would call the LLM
            pass
            
        return tool_calls
    
    def _ai_dispatch(self, query: str) -> List[ToolCall]:
        """Use AI to determine which tools to call"""
        # In a real implementation, this would use OpenAI Function Calling or similar
        # For the prototype, we'll just use the rule-based approach
        return self._rule_based_dispatch(query)
    
    def process_query(self, query: str) -> AgentResponse:
        """Process a natural language query from the user"""
        # Store the query in history
        self.history.append({"role": "user", "content": query})
        
        # Determine which tools to call
        tool_calls = self._ai_dispatch(query)
        
        # Execute the tool calls
        tool_results = []
        for tool_call in tool_calls:
            tool_name = tool_call.tool
            if tool_name in self.tools:
                try:
                    result = self.tools[tool_name].execute(**tool_call.parameters)
                    tool_results.append({
                        "tool": tool_name,
                        "parameters": tool_call.parameters,
                        "result": result
                    })
                except Exception as e:
                    tool_results.append({
                        "tool": tool_name,
                        "parameters": tool_call.parameters,
                        "error": str(e)
                    })
            else:
                tool_results.append({
                    "tool": tool_name,
                    "parameters": tool_call.parameters,
                    "error": f"Tool '{tool_name}' not found"
                })
        
        # Generate a response
        if tool_results:
            # In a real system, we'd use the LLM to generate a response based on tool results
            message = self._generate_response(query, tool_results)
        else:
            # If no tools were called, generate a direct response
            message = "I'm not sure how to help with that. Can you be more specific?"
        
        # Store the response in history
        self.history.append({"role": "assistant", "content": message})
        
        return AgentResponse(
            message=message,
            tool_calls=[tool_call.dict() for tool_call in tool_calls],
            tool_results=tool_results
        )
    
    def _generate_response(self, query: str, tool_results: List[Dict[str, Any]]) -> str:
        """Generate a response based on the tool results"""
        # For the prototype, we'll use a simple template-based approach
        # In a real system, we would use the LLM
        
        responses = []
        for result in tool_results:
            tool = result["tool"]
            if "error" in result:
                responses.append(f"Error calling {tool}: {result['error']}")
                continue
                
            if tool == "codebase_search":
                matches = result["result"].get("matches", [])
                if matches:
                    responses.append(f"Found {len(matches)} matches for your search.")
                else:
                    responses.append("No matches found in the codebase.")
                    
            elif tool == "read_file":
                if "error" in result["result"]:
                    responses.append(f"Error reading file: {result['result']['error']}")
                else:
                    responses.append(f"File contents of {result['result']['file']} retrieved.")
                    
            elif tool == "list_dir":
                if "error" in result["result"]:
                    responses.append(f"Error listing directory: {result['result']['error']}")
                else:
                    path = result["result"]["path"]
                    num_files = len(result["result"]["files"])
                    num_dirs = len(result["result"]["directories"])
                    responses.append(f"Directory {path} contains {num_files} files and {num_dirs} subdirectories.")
                    
            elif tool == "edit_file":
                if "error" in result["result"]:
                    responses.append(f"Error editing file: {result['result']['error']}")
                else:
                    file = result["result"]["file"]
                    responses.append(f"Successfully edited {file}.")
                    
            # Add more tool-specific responses here
            
        if responses:
            return " ".join(responses)
        else:
            return "I processed your request, but I'm not sure how to summarize the results."

    def reset(self):
        """Reset the agent's history"""
        self.history = []