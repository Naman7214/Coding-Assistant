import json
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List

import httpx
import tiktoken
from config.settings import settings
from prompts.memory_summarization_prompt import MEMORY_SUMMARIZATION_PROMPT
from repositories.llm_usage_repository import LLMUsageRepository


class AgentMemory:
    """
    Enhanced memory management system with token counting, caching, and summarization.

    Features:
    1. System prompt caching with Anthropic cache_control
    2. Token counting with tiktoken
    3. Memory summarization when exceeding 100k tokens
    4. Simple variable-based memory storage
    5. OpenAI API integration for summarization
    """

    def __init__(self, model_name="claude-sonnet-4-20250514"):
        # Configuration
        self.model_name = model_name
        self.max_tokens = 100000
        self.keep_last_messages = 5

        # Token counting
        self.encoding = tiktoken.get_encoding("cl100k_base")

        self.system_prompt_cache = None
        self.conversation_memory = []
        self.summary_memory = None
        self.current_token_count = 0

        # Tool tracking
        self.tool_calls_history = []
        self.total_tool_calls = 0

        # Session metadata
        self.session_start_time = time.time()

        # HTTP client for OpenAI summarization
        self.timeout = httpx.Timeout(
            connect=60.0,
            read=300.0,
            write=120.0,
            pool=60.0,
        )

        # Initialize LLM usage repository for logging OpenAI usage
        self.llm_usage_repository = LLMUsageRepository()

    def _count_tokens(self, text: str) -> int:
        """Count tokens in text using tiktoken"""
        try:
            tokens = self.encoding.encode(text)
            return len(tokens)
        except Exception as e:
            # Fallback: estimate 4 characters per token
            return len(text) // 4

    def _count_message_tokens(self, message: Dict[str, Any]) -> int:
        """Count tokens in a message"""
        try:
            message_text = json.dumps(message)
            return self._count_tokens(message_text)
        except Exception:
            return len(str(message)) // 4

    def initialize_with_system_message(self, system_message: str):
        """Initialize with cached system message"""
        # Create system prompt with cache control for Anthropic caching
        self.system_prompt_cache = [
            {
                "type": "text",
                "text": system_message,
                "cache_control": {
                    "type": "ephemeral",
                    "ttl": "1h",
                },
            }
        ]

        # Count tokens for the system message
        system_tokens = self._count_tokens(system_message)
        self.current_token_count = system_tokens

        print(
            f"✅ Enhanced Memory: System prompt initialized with {system_tokens} tokens (cached)"
        )

    def add_user_message(self, message: str):
        """Add user message to memory"""
        user_msg = {
            "role": "user",
            "content": [{"type": "text", "text": message}],
            "timestamp": time.time(),
        }

        self.conversation_memory.append(user_msg)
        message_tokens = self._count_message_tokens(user_msg)
        self.current_token_count += message_tokens

        print(f"Enhanced Memory: Added user message ({message_tokens} tokens)")
        self._check_and_summarize()

    def add_assistant_message(self, message: Dict[str, Any]):
        """Add assistant message to memory"""
        # Add timestamp for tracking
        message_with_meta = message.copy()
        message_with_meta["timestamp"] = time.time()

        self.conversation_memory.append(message_with_meta)
        message_tokens = self._count_message_tokens(message_with_meta)
        self.current_token_count += message_tokens

        print(
            f"Enhanced Memory: Added assistant message ({message_tokens} tokens)"
        )
        self._check_and_summarize()

    def add_tool_call(self, tool_call: Dict[str, Any], result: str):
        """Record tool call and result"""
        call_info = {
            "tool": tool_call.get("name", ""),
            "arguments": tool_call.get("input", {}),
            "result_summary": (
                result[:200] + "..." if len(result) > 200 else result
            ),
            "timestamp": time.time(),
            "success": not result.startswith("ERROR:"),
        }

        self.tool_calls_history.append(call_info)
        self.total_tool_calls += 1

    def add_tool_result(self, tool_use_id: str, content: str):
        """Add tool result to memory"""
        # Check for duplicate tool IDs
        for message in self.conversation_memory:
            if message.get("role") == "user" and message.get("content"):
                for block in message.get("content", []):
                    if (
                        block.get("type") == "tool_result"
                        and block.get("tool_use_id") == tool_use_id
                    ):
                        # Generate new unique ID
                        new_id = f"unique_{uuid.uuid4().hex[:8]}"
                        print(
                            f"Enhanced Memory: Duplicate tool ID detected. Changing {tool_use_id} to {new_id}"
                        )
                        tool_use_id = new_id
                        break

        tool_result_msg = {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                }
            ],
            "timestamp": time.time(),
        }

        self.conversation_memory.append(tool_result_msg)
        message_tokens = self._count_message_tokens(tool_result_msg)
        self.current_token_count += message_tokens

        print(f"Enhanced Memory: Added tool result ({message_tokens} tokens)")
        self._check_and_summarize()

    def _check_and_summarize(self):
        """Check if summarization is needed and perform it"""
        if self.current_token_count > self.max_tokens:
            print(
                f"Enhanced Memory: Token limit exceeded ({self.current_token_count} > {self.max_tokens}). Starting summarization..."
            )
            # Schedule summarization to run asynchronously
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # If we're in an async context, create a task
                    asyncio.create_task(self._summarize_memory())
                else:
                    # If not in async context, run it
                    loop.run_until_complete(self._summarize_memory())
            except RuntimeError:
                # If no event loop, create one
                asyncio.run(self._summarize_memory())

    async def _summarize_memory(self):
        """Summarize memory excluding last 5 messages using OpenAI API"""
        if len(self.conversation_memory) <= self.keep_last_messages:
            print("Enhanced Memory: Too few messages to summarize")
            return

        # Split messages: old (to summarize) and recent (to keep)
        messages_to_summarize = self.conversation_memory[
            : -self.keep_last_messages
        ]
        recent_messages = self.conversation_memory[-self.keep_last_messages :]

        # Create text for summarization
        summary_text = self._create_summary_text(messages_to_summarize)

        try:
            # Generate summary using OpenAI API
            new_summary = await self._generate_openai_summary(summary_text)

            # Update memory structure
            if self.summary_memory:
                # Combine with existing summary
                combined_summary = f"{self.summary_memory}\n\n--- NEW SUMMARY ---\n{new_summary}"
                self.summary_memory = combined_summary
            else:
                self.summary_memory = new_summary

            # Replace conversation memory with recent messages only
            self.conversation_memory = recent_messages

            # Recalculate token count
            self._recalculate_token_count()

            print(
                f"✅ Enhanced Memory: Summarization complete. New token count: {self.current_token_count}"
            )

        except Exception as e:
            print(f"❌ Enhanced Memory: Summarization failed: {str(e)}")

    def _create_summary_text(self, messages: List[Dict[str, Any]]) -> str:
        """Create text representation of messages for summarization"""
        summary_parts = []

        for msg in messages:
            role = msg.get("role", "unknown")
            timestamp = msg.get("timestamp", 0)
            time_str = datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")

            if role == "user":
                content = self._extract_text_from_content(
                    msg.get("content", [])
                )
                if content:
                    summary_parts.append(f"[{time_str}] User: {content}")
            elif role == "assistant":
                content = self._extract_text_from_content(
                    msg.get("content", [])
                )
                if content:
                    summary_parts.append(f"[{time_str}] Assistant: {content}")

        return "\n".join(summary_parts)

    def _extract_text_from_content(self, content: List[Dict[str, Any]]) -> str:
        """Extract text from message content blocks"""
        text_parts = []
        for block in content:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                tool_name = block.get("name", "unknown")
                text_parts.append(f"[Used tool: {tool_name}]")
            elif block.get("type") == "tool_result":
                text_parts.append("[Tool result received]")

        return " ".join(text_parts)

    async def _generate_openai_summary(self, text_to_summarize: str) -> str:
        """Generate summary using OpenAI API"""
        url = "https://api.openai.com/v1/chat/completions"

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        }

        payload = {
            "model": "gpt-4.1-mini-2025-04-14",
            "messages": [
                {"role": "system", "content": MEMORY_SUMMARIZATION_PROMPT},
                {"role": "user", "content": f"{text_to_summarize}"},
            ],
            "max_tokens": 3000,
            "temperature": 0.3,
        }

        start_time = time.time()

        async with httpx.AsyncClient(
            verify=False, timeout=self.timeout
        ) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()

            response_data = response.json()
            duration = time.time() - start_time

            # Log OpenAI usage
            try:
                usage_info = response_data.get("usage", {})
                input_tokens = usage_info.get("input_tokens", 0)
                output_tokens = usage_info.get("output_tokens", 0)
                total_tokens = usage_info.get("total_tokens", 0)

                # Create usage data for logging
                usage_data = {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cache_creation_input_tokens": 0,  # OpenAI doesn't use cache tokens like Anthropic
                    "cache_read_input_tokens": 0,
                    "duration": duration,
                    "provider": "OpenAI",
                    "model": payload["model"],
                    "request_id": response_data.get("id", "unknown"),
                    "request_type": "memory_summarization",
                }

                # Log usage via repository
                success = await self.llm_usage_repository.log_llm_usage(
                    usage_data
                )
                if success:
                    print(
                        f"✅ Enhanced Memory: OpenAI usage logged - Input: {input_tokens}, Output: {output_tokens}, Total: {total_tokens}"
                    )
                else:
                    print("⚠️ Enhanced Memory: Failed to log OpenAI usage")

            except Exception as log_error:
                print(
                    f"⚠️ Enhanced Memory: Error logging OpenAI usage: {str(log_error)}"
                )

            if "choices" in response_data and len(response_data["choices"]) > 0:
                summary = response_data["choices"][0]["message"]["content"]
                print(
                    f"✅ Enhanced Memory: OpenAI summary generated: {summary}..."
                )
                return summary
            else:
                raise Exception("No summary generated by OpenAI API")

    def _recalculate_token_count(self):
        """Recalculate total token count"""
        total_tokens = 0

        # Count system prompt tokens
        if self.system_prompt_cache:
            for block in self.system_prompt_cache:
                total_tokens += self._count_tokens(block.get("text", ""))

        # Count summary tokens
        if self.summary_memory:
            total_tokens += self._count_tokens(self.summary_memory)

        # Count conversation tokens
        for msg in self.conversation_memory:
            total_tokens += self._count_message_tokens(msg)

        self.current_token_count = total_tokens

    def get_conversation_messages(self) -> List[Dict[str, Any]]:
        """Get messages for API calls with cached system prompt"""
        messages = []

        # Add summary if exists
        if self.summary_memory:
            summary_msg = {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"<CONVERSATION_SUMMARY>\n{self.summary_memory}\n</CONVERSATION_SUMMARY>",
                    }
                ],
            }
            messages.append(summary_msg)

        # Add recent conversation messages (without timestamps)
        for msg in self.conversation_memory:
            clean_msg = msg.copy()
            clean_msg.pop("timestamp", None)  # Remove timestamp for API
            messages.append(clean_msg)

        return messages

    def get_system_prompt_with_cache(self) -> List[Dict[str, Any]]:
        """Get system prompt with cache control"""
        return self.system_prompt_cache if self.system_prompt_cache else []


# Import asyncio at the end to avoid circular imports
import asyncio
