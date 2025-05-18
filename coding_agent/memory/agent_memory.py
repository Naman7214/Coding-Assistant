import json
import time


class AgentMemory:
    def __init__(self):
        # Full conversation history including system, user, assistant messages and tool calls
        self.full_history = []
        # Record of tool calls for agent self-reflection
        self.tool_calls_history = []
        # Track what tools were used in current session
        self.tools_used_session = set()
        # Total number of tool calls made
        self.total_tool_calls = 0

    def initialize_with_system_message(self, system_message):
        """Initialize the conversation with a system message"""
        self.full_history = [{"role": "system", "content": system_message}]

    def add_user_message(self, message):
        """Add a user message to the conversation history"""
        self.full_history.append(
            {"role": "user", "content": [{"type": "text", "text": message}]}
        )

    def add_assistant_message(self, message):
        """Add an assistant message to the conversation history"""
        self.full_history.append(message)

    def add_tool_call(self, tool_call, result):
        """Record a tool call and its result"""
        call_info = {
            "tool": tool_call.get("name", ""),
            "arguments": tool_call.get("input", {}),
            "result_summary": (
                str(result)[:200] + "..."
                if len(str(result)) > 200
                else str(result)
            ),
            "timestamp": time.time(),
        }
        self.tool_calls_history.append(call_info)
        self.tools_used_session.add(tool_call.get("name", ""))
        self.total_tool_calls += 1

    def add_tool_result(self, tool_use_id, content):
        """Add a tool result to the conversation history"""
        self.full_history.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                    }
                ],
            }
        )

    def get_conversation_messages(self):
        """Get all messages for sending to the LLM"""
        return self.full_history

    def get_recent_conversation(self, num_exchanges=5):
        """Get the most recent conversation exchanges"""
        # Filter to just get user and assistant messages for summary
        messages = [
            msg
            for msg in self.full_history
            if msg["role"] in ["user", "assistant"]
        ]
        return messages[-min(num_exchanges * 2, len(messages)) :]

    def get_tool_usage_summary(self):
        """Create a summary of tool usage for the agent"""
        if not self.tool_calls_history:
            return "No tools have been used yet."

        summary = (
            f"Tool usage summary (total calls: {self.total_tool_calls}):\n"
        )
        for tool in self.tools_used_session:
            count = sum(
                1 for call in self.tool_calls_history if call["tool"] == tool
            )
            summary += f"- {tool}: used {count} times\n"

        # Add the last 3 tool calls for context
        if self.tool_calls_history:
            summary += "\nMost recent tool calls:\n"
            for call in self.tool_calls_history[-3:]:
                summary += f"- {call['tool']}: {json.dumps(call['arguments'])[:100]}...\n"

        return summary
