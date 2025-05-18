import logging
from typing import Any, Dict, Optional

from agent.adapters.llm_adapter import LLMAdapter

# from agent.adapters.tool_adapter import ToolAdapter
from agent.adapters.tool_adapter import ToolAdapter
from agent.config.settings import settings
from agent.memory.agent_memory import MongoDBMemory
from agent.models.schemas import AgentState, ToolCall, UserQuery

logger = logging.getLogger(__name__)


class Orchestrator:
    """
    Main orchestrator that manages the workflow for the agent system.
    This orchestrator runs a single agent in a loop to process user requests.
    """
    def __init__(self, llm_adapter: LLMAdapter, tool_adapter: ToolAdapter = ToolAdapter()):
        self.llm_adapter = llm_adapter
        self.tool_adapter = tool_adapter
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

        tool_call_count = 0
        agent_state = AgentState(
            conversation_history=conversation_history,
            current_tool_calls=[],
            available_tools="self.tool_adapter.get_available_tools()",
            completed=False,
        )

        # Add user query to conversation history
        user_message = {"role": "user", "content": user_query.text}
        await self.memory.add_message(session_id, user_message)
        conversation_history.append(user_message)

        # Define a function to handle user continuation prompts
        async def ask_user_to_continue() -> Dict[str, Any]:
            """
            Ask the user if they want to continue processing with more tool calls.
            Returns a response dictionary indicating we're waiting for user input.
            """
            # Add a message to the conversation asking the user if they want to continue
            continuation_prompt = {
                "role": "assistant",
                "content": f"I've made {tool_call_count} tool calls to process your request. Would you like me to continue or stop here? (Reply with 'continue' or 'stop')",
            }
            await self.memory.add_message(session_id, continuation_prompt)
            conversation_history.append(continuation_prompt)

            # Return a response indicating we're waiting for user input
            return {
                "conversation_history": conversation_history,
                "tool_call_count": tool_call_count,
                "completed": False,
                "session_id": session_id,
                "waiting_for_continuation": True,
            }

        # Function to process the user's continuation decision
        async def process_continuation_decision(
            decision: str,
        ) -> Optional[Dict[str, Any]]:
            """Process the user's decision to continue or stop."""
            decision = decision.lower().strip()
            if decision in ["continue", "yes", "y"]:
                # User wants to continue, just return None to let the loop continue
                return None
            else:
                # User wants to stop, add a final message and return the result
                stop_message = {
                    "role": "assistant",
                    "content": "I've stopped processing your request as requested. If you need further assistance, please let me know.",
                }
                await self.memory.add_message(session_id, stop_message)
                conversation_history.append(stop_message)

                return {
                    "conversation_history": conversation_history,
                    "tool_call_count": tool_call_count,
                    "completed": True,
                    "session_id": session_id,
                }

        # Check if this is a continuation response from the user
        if user_query.is_continuation_response:
            result = await process_continuation_decision(user_query.text)
            if result:
                return result
            # If no result was returned, the user wants to continue, so we'll fall through to the main loop

        # Start the agent loop
        while not agent_state.completed:
            next_action = await self.llm_adapter.determine_next_action(
                agent_state, session_id
            )

            if next_action.action_type == "tool_call":
                # Execute the tool
                tool_call_count += 1
                logger.info(
                    f"Executing tool: {next_action.tool_name} (call {tool_call_count})"
                )

                # Ensure tool_name and parameters are not None
                tool_name = next_action.tool_name or ""
                parameters = next_action.parameters or {}

                tool_call = ToolCall(
                    tool_name=tool_name,
                    parameters=parameters,
                )

                assistant_message = {
                    "role": "assistant",
                    "thought": next_action.thought,
                    "tool_call": {
                        "name": tool_call.tool_name,
                        "parameters": tool_call.parameters,
                    },
                }
                await self.memory.add_message(session_id, assistant_message)
                conversation_history.append(assistant_message)

                # tool_result = await self.tool_adapter.execute_tool(tool_call)

                tool_message = {
                    "role": "tool",
                    "tool_call_id": tool_call_count,
                    "name": tool_call.tool_name,
                    "content": "tool_result.content",
                }
                await self.memory.add_message(session_id, tool_message)
                conversation_history.append(tool_message)

                # Check if we've exceeded the threshold of 25 tool calls
                if (
                    tool_call_count >= 3
                    and not user_query.is_continuation_response
                ):
                    continuation_response = await ask_user_to_continue()
                    return continuation_response

            elif next_action.action_type == "final_response":
                final_response = {
                    "role": "assistant",
                    "thought": next_action.thought,
                    "content": next_action.content,
                }
                await self.memory.add_message(session_id, final_response)
                conversation_history.append(final_response)
                agent_state.completed = True

        return {
            "conversation_history": conversation_history,
            "tool_call_count": tool_call_count,
            "completed": agent_state.completed,
            "session_id": session_id,
        }
