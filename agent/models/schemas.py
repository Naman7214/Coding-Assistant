from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class UserQuery(BaseModel):
    """
    Represents a user query to the agent system.
    """

    text: str = Field(..., description="The text of the user's query")
    session_id: Optional[str] = Field(
        None, description="Session ID for continuing conversations"
    )
    is_continuation_response: bool = Field(
        False,
        description="Flag indicating if this is a response to a continuation prompt",
    )


class ToolCall(BaseModel):
    """
    Represents a tool call to be executed.
    """

    tool_name: str = Field(..., description="The name of the tool to call")
    parameters: Dict[str, Any] = Field(
        default_factory=dict, description="Parameters to pass to the tool"
    )
    thought: Optional[str] = Field(None, description="Thought process behind the tool call")


class ToolResult(BaseModel):
    """
    Represents the result of a tool execution.
    """

    success: bool = Field(
        ..., description="Whether the tool execution was successful"
    )
    content: Any = Field(..., description="The content returned by the tool")
    error: Optional[str] = Field(
        None, description="Error message if the tool execution failed"
    )


