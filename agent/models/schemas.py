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


class SingleAgentIteration(BaseModel):
    """
    Represents an action determined by the agent.
    """

    action_type: Optional[str] = Field(
        None, description="Type of action: 'tool_call' or 'final_response'"
    )
    tool_name: Optional[str] = Field(
        None,
        description="Name of the tool to call (if action_type is 'tool_call')",
    )
    parameters: Optional[Dict[str, Any]] = Field(
        None, description="Parameters for the tool call"
    )
    content: Optional[str] = Field(
        None,
        description="Content of the final response (if action_type is 'final_response')",
    )
    thought: Optional[str] = Field(
        None,
        description="Explanatory message to the user about the action being taken and it's internal reasoning",
    )


class AgentState(BaseModel):
    """
    Represents the current state of the agent during a conversation.
    """

    conversation_history: List[Dict[str, Any]] = Field(
        default_factory=list, description="History of the conversation so far"
    )
    current_tool_calls: List[ToolCall] = Field(
        default_factory=list,
        description="List of tool calls made in the current iteration",
    )
    available_tools: Any = Field(
        default_factory=list,
        description="List of available tools the agent can use",
    )
    completed: bool = Field(
        default=False,
        description="Whether the agent has completed processing the query",
    )
