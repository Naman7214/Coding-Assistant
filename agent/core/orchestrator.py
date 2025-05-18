import logging
from typing import Any, Dict, Optional

from agent.adapters.llm_adapter import LLMAdapter

# from agent.adapters.tool_adapter import ToolAdapter
from agent.adapters.tool_adapter import ToolAdapter
from agent.config.settings import settings
from agent.memory.agent_memory import MongoDBMemory
from agent.models.schemas import ToolCall, UserQuery

logger = logging.getLogger(__name__)


class Orchestrator:
    """
    Main orchestrator that manages the workflow for the agent system.
    This orchestrator processes user requests and handles tool calls.
    """
    def __init__(self, llm_adapter: LLMAdapter):
        self.llm_adapter = llm_adapter
        self.tool_adapter = ToolAdapter()
        self.max_tool_calls = settings.MAX_TOOL_CALLS_PER_SESSION
        self.memory = MongoDBMemory()

    async def process_query(self, user_query: UserQuery) -> Dict[str, Any]:
        """
        Process a user query through the agent workflow.

        Args:
            user_query: The user's query/request

        Returns:
            Dict containing the final response and execution history
        """
        # Create or retrieve session
        session_id = user_query.session_id
        if not session_id:
            session_id = await self.memory.create_session()

        # Get conversation history from MongoDB
        conversation_history = await self.memory.get_conversation_history(
            session_id
        )
        
        # Get persistent tool and iteration counts
        tool_call_count, iteration_count = await self.memory.get_session_counts(session_id)

        # Add user query to conversation history
        user_message = {"role": "user", "content": user_query.text}
        await self.memory.add_message(session_id, user_message)
        conversation_history.append(user_message)


        # Function to handle user continuation prompts
        async def ask_user_to_continue() -> Dict[str, Any]:
            """
            Ask the user if they want to continue processing with more tool calls.
            """
            continuation_prompt = {
                "role": "assistant",
                "content": f"I've made {tool_call_count} tool calls to process your request. Would you like me to continue or stop here? (Reply with 'continue' or 'stop')",
            }
            await self.memory.add_message(session_id, continuation_prompt)
            conversation_history.append(continuation_prompt)

            return {
                "conversation_history": conversation_history,
                "completed": False,
                "session_id": session_id,
                "waiting_for_continuation": True,
            }

        # Function to process the user's continuation decision
        async def process_continuation_decision(decision: str) -> Optional[Dict[str, Any]]:
            """Process the user's decision to continue or stop."""
            decision = decision.lower().strip()
            if decision in ["continue", "yes", "y"]:
                return None  # Continue processing
            else:
                # User wants to stop
                stop_message = {
                    "role": "assistant",
                    "content": "I've stopped processing your request as requested. If you need further assistance, please let me know.",
                }
                await self.memory.add_message(session_id, stop_message)
                conversation_history.append(stop_message)

                return {
                    "conversation_history": conversation_history,
                    "completed": True,
                    "session_id": session_id,
                }

        # Check if this is a continuation response from the user
        if user_query.is_continuation_response:
            result = await process_continuation_decision(user_query.text)
            if result:
                return result

        # Process the query in a loop until we get a final response or hit the tool call limit
        while True:
            # Increment iteration count
            iteration_count += 1
            # Update counts in MongoDB
            await self.memory.update_counts(session_id, tool_call_count, iteration_count)
            
            # Hard limit on total iterations
            if iteration_count > 30:
                final_message = {
                    "role": "assistant",
                    "content": "I've reached the maximum limit of 30 iterations for this session. Here's what I've found so far.",
                }
                await self.memory.add_message(session_id, final_message)
                conversation_history.append(final_message)
                
                return {
                    "conversation_history": conversation_history,
                    "tool_call_count": tool_call_count,
                    "completed": True,
                    "session_id": session_id,
                }
            
            # Get the next action from the LLM
            next_action = await self.llm_adapter.determine_next_action(session_id)

            # Check if it's a tool call
            if next_action["is_tool_call"]:
                # Increment tool call count
                tool_call_count += 1
                # Update counts in MongoDB
                await self.memory.update_counts(session_id, tool_call_count, iteration_count)
                
                logger.info(f"Executing tool: {next_action['tool_name']} (call {tool_call_count})")
                
                # Create the tool call
                tool_call = ToolCall(
                    tool_name=next_action["tool_name"],
                    parameters=next_action["tool_parameters"],
                    thought=next_action["thought"]
                )

                # Add the assistant's tool call message to conversation history
                assistant_message = {
                    "role": "assistant",
                    "content": "",  # No content for tool calls
                    "tool_call": {
                        "name": tool_call.tool_name,
                        "parameters": tool_call.parameters,
                    },
                    "thought": tool_call.thought
                }
                await self.memory.add_message(session_id, assistant_message)
                conversation_history.append(assistant_message)

                # Execute the tool
                tool_result = await self.tool_adapter.execute_tool(tool_call)

                # Add the tool result to conversation history
                tool_message = {
                    "role": "tool",
                    "name": tool_call.tool_name,
                    "content": tool_result.content,
                }
                await self.memory.add_message(session_id, tool_message)
                conversation_history.append(tool_message)

                # Check if we've exceeded the threshold of tool calls (25)
                if tool_call_count >= 25 and not user_query.is_continuation_response:
                    return await ask_user_to_continue()

            else:
                # This is a regular response 
                final_message = {
                    "role": "assistant",
                    "content": next_action["content"],
                }
                await self.memory.add_message(session_id, final_message)
                conversation_history.append(final_message)

                return {
                    "conversation_history": conversation_history,
                    "tool_call_count": tool_call_count,
                    "completed": False,
                    "session_id": session_id,
                }
