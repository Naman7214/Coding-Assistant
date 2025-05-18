import logging
from typing import Dict, List, Optional, Any

from agent.models.schemas import UserQuery, ToolCall, AgentState
from agent.adapters.llm_adapter import LLMAdapter
from agent.adapters.tool_adapter import ToolAdapter
from agent.config.settings import settings

logger = logging.getLogger(__name__)

class Orchestrator:
    """
    Main orchestrator that manages the workflow for the agent system.
    This orchestrator runs a single agent in a loop to process user requests.
    """
    
    def __init__(self, llm_adapter: LLMAdapter, tool_adapter: ToolAdapter):
        self.llm_adapter = llm_adapter
        self.tool_adapter = tool_adapter
        self.max_tool_calls = settings.MAX_TOOL_CALLS_PER_SESSION
        
    async def process_query(self, user_query: UserQuery) -> Dict[str, Any]:
        """
        Process a user query through the agent workflow.
        
        Args:
            user_query: The user's query/request
            
        Returns:
            Dict containing the final response and execution history
        """
        conversation_history = []
        tool_call_count = 0
        agent_state = AgentState(
            conversation_history=conversation_history,
            current_tool_calls=[],
            available_tools=self.tool_adapter.get_available_tools(),
            completed=False,
            requires_user_input=False
        )
        
        # Add user query to conversation history
        conversation_history.append({
            "role": "user",
            "content": user_query.text
        })
        
        # Start the agent loop
        while not agent_state.completed:
            # Check if we've reached the maximum number of tool calls
            if tool_call_count >= self.max_tool_calls:
                # Ask the user if they want to continue
                continuation_response = {
                    "role": "assistant",
                    "content": f"I've made {tool_call_count} tool calls to process your request. Would you like me to continue?",
                    "requires_user_response": True
                }
                agent_state.requires_user_input = True
                conversation_history.append(continuation_response)
                break
            
            # Determine the next tool to call
            next_action = await self.llm_adapter.determine_next_action(agent_state)
            
            if next_action.action_type == "tool_call":
                # Execute the tool
                tool_call_count += 1
                logger.info(f"Executing tool: {next_action.tool_name} (call {tool_call_count})")
                
                tool_call = ToolCall(
                    tool_name=next_action.tool_name,
                    parameters=next_action.parameters
                )

                conversation_history.append({
                    "role": "assistant",
                    "content": None,
                    "tool_call": {
                        "name": tool_call.tool_name,
                        "parameters": tool_call.parameters
                    }
                })
                
                tool_result = await self.tool_adapter.execute_tool(tool_call)

                conversation_history.append({
                    "role": "tool",
                    "tool_call_id": tool_call_count,
                    "name": tool_call.tool_name,
                    "content": tool_result.content
                })
                
            elif next_action.action_type == "final_response":

                final_response = {
                    "role": "assistant",
                    "content": next_action.content
                }
                conversation_history.append(final_response)
                agent_state.completed = True
        
        return {
            "conversation_history": conversation_history,
            "tool_call_count": tool_call_count,
            "completed": agent_state.completed,
            "requires_user_input": agent_state.requires_user_input
        }

    async def continue_session(self, user_query: UserQuery, previous_conversation: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Continue processing a query with existing conversation history.
        
        Args:
            user_query: The new user query to process
            previous_conversation: The previous conversation history
            
        Returns:
            Dict containing the updated response and execution history
        """
        # Start with the previous conversation history
        conversation_history = previous_conversation.copy()
        
        # Add the new user query to the conversation history
        conversation_history.append({
            "role": "user",
            "content": user_query.text
        })
        
        # Reset the tool call count for this continuation
        tool_call_count = 0
        
        # Initialize the agent state with the existing conversation
        agent_state = AgentState(
            conversation_history=conversation_history,
            current_tool_calls=[],
            available_tools=self.tool_adapter.get_available_tools(),
            completed=False,
            requires_user_input=False
        )
        
        # Start the agent loop
        while not agent_state.completed:
            # Check if we've reached the maximum number of tool calls
            if tool_call_count >= self.max_tool_calls:
                # Ask the user if they want to continue
                continuation_response = {
                    "role": "assistant",
                    "content": f"I've made {tool_call_count} tool calls to process your request. Would you like me to continue?",
                    "requires_user_response": True
                }
                agent_state.requires_user_input = True
                conversation_history.append(continuation_response)
                break
            
            # Determine the next tool to call
            next_action = await self.llm_adapter.determine_next_action(agent_state)
            
            if next_action.action_type == "tool_call":
                # Execute the tool
                tool_call_count += 1
                logger.info(f"Executing tool: {next_action.tool_name} (call {tool_call_count})")
                
                tool_call = ToolCall(
                    tool_name=next_action.tool_name,
                    parameters=next_action.parameters
                )

                conversation_history.append({
                    "role": "assistant",
                    "content": None,
                    "tool_call": {
                        "name": tool_call.tool_name,
                        "parameters": tool_call.parameters
                    }
                })
                
                tool_result = await self.tool_adapter.execute_tool(tool_call)

                conversation_history.append({
                    "role": "tool",
                    "tool_call_id": tool_call_count,
                    "name": tool_call.tool_name,
                    "content": tool_result.content
                })
                
            elif next_action.action_type == "final_response":
                final_response = {
                    "role": "assistant",
                    "content": next_action.content
                }
                conversation_history.append(final_response)
                agent_state.completed = True
        
        return {
            "conversation_history": conversation_history,
            "tool_call_count": tool_call_count,
            "completed": agent_state.completed,
            "requires_user_input": agent_state.requires_user_input
        }
