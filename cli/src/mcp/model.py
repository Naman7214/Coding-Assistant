"""
Model component for the MCP architecture.
Represents the data and business logic of the application.
"""
from typing import Dict, List, Any, Optional
from pydantic import BaseModel, Field

class ToolResult(BaseModel):
    """Model for a tool execution result"""
    tool: str = Field(..., description="Name of the tool that was called")
    parameters: Dict[str, Any] = Field(default_factory=dict, description="Parameters used for the tool call")
    result: Dict[str, Any] = Field(default_factory=dict, description="Result of the tool execution")
    error: Optional[str] = Field(None, description="Error message if the tool execution failed")

class QueryResponse(BaseModel):
    """Model for a response to a user query"""
    message: str = Field(..., description="Response message to display to the user")
    tool_results: List[ToolResult] = Field(default_factory=list, description="Results of tool executions")
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to a dictionary"""
        return {
            "message": self.message,
            "tool_results": [tool_result.dict() for tool_result in self.tool_results]
        }