import logging
from typing import Any, Dict

from agent.adapters.llm_adapter import LLMAdapter
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

    def __init__(self, llm_adapter: LLMAdapter, tool_adapter: ToolAdapter):
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
            available_tools=self.tool_adapter.get_available_tools(),
            completed=False,
        )

        # Add user query to conversation history
        user_message = {"role": "user", "content": user_query.text}
        await self.memory.add_message(session_id, user_message)
        conversation_history.append(user_message)

        # Start the agent loop
        while not agent_state.completed:
            next_action = await self.llm_adapter.determine_next_action(
                agent_state
            )

            if next_action.action_type == "tool_call":
                # Execute the tool
                tool_call_count += 1
                logger.info(
                    f"Executing tool: {next_action.tool_name} (call {tool_call_count})"
                )

                tool_call = ToolCall(
                    tool_name=next_action.tool_name,
                    parameters=next_action.parameters,
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

                tool_result = await self.tool_adapter.execute_tool(tool_call)

                tool_message = {
                    "role": "tool",
                    "tool_call_id": tool_call_count,
                    "name": tool_call.tool_name,
                    "content": tool_result.content,
                }
                await self.memory.add_message(session_id, tool_message)
                conversation_history.append(tool_message)

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
