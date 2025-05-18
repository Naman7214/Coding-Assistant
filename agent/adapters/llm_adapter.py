import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException

from agent.config.settings import settings
from agent.memory.agent_memory import MongoDBMemory
from agent.models.schemas import ToolCall

logger = logging.getLogger(__name__)


class LLMAdapter:
    """
    Adapter for interacting with the LLM (Claude 3.7 Sonnet).
    Handles prompt creation and response parsing.
    """

    def __init__(self):
        self.api_key = settings.CLAUDE_API_KEY
        self.anthropic_version = settings.ANTHROPIC_VERSION
        self.model = settings.CLAUDE_MODEL
        self.base_url = settings.CLAUDE_BASE_URL
        self.messages_endpoint = settings.CLAUDE_MESSAGES_ENDPOINT
        self.timeout = httpx.Timeout(
            connect=60.0, read=300.0, write=300.0, pool=60.0
        )
        self.memory = MongoDBMemory()

    async def determine_next_action(self, session_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Determine the next action based on the conversation history.

        Args:
            session_id: Session ID to retrieve conversation history from MongoDB

        Returns:
            Dict with action information:
            - "is_tool_call": Whether the action is a tool call or not
            - "tool_name": The name of the tool to call (if is_tool_call is True)
            - "tool_parameters": The parameters for the tool call (if is_tool_call is True)
            - "thought": Thought process behind the action
            - "content": The text content (if is_tool_call is False)
            - "is_end": Whether this is the final response marking the end of the task
        """
        # Get conversation history
        conversation_history = []
        if session_id:
            conversation_history = await self.memory.get_conversation_history(session_id)
        
        # Create system prompt
        system_prompt = """You are an AI assistant with access to various tools. 
If you decide to use a tool, return a JSON response in a code block with the format:
```json
{
  "thought": "thought behind this tools use",
  "tool_name": "name_of_tool",
  "tool_parameters": {
    "param1": "value1",
    "param2": "value2"
  }
}
```

If you decide to give a regular response, just respond normally without any JSON code block.

Available tools:
- read_file: Reads the contents of a file
- write_file: Writes to a file
- list_directory: Lists the contents of a directory
- search_files: Searches for files matching a pattern
- grep_search: Searches for text patterns in files
- run_terminal_cmd: Executes a terminal command
- web_search: Searches the web for information
"""

        # Format conversation history for the LLM
        formatted_messages = []
        for message in conversation_history:
            role = message.get("role", "")
            content = message.get("content", "")
            
            if role == "user":
                formatted_messages.append({"role": "user", "content": content})
            elif role == "assistant":
                formatted_messages.append({"role": "assistant", "content": content})
            elif role == "tool":
                # Format tool responses
                formatted_messages.append({
                    "role": "user", 
                    "content": f"[Tool Result: {message.get('name', 'unknown')}] {content}"
                })

        # Call the LLM
        response = await self.completions(
            system_prompt=system_prompt, 
            messages=formatted_messages
        )

        return self._parse_response(response)

    async def completions(
        self,
        system_prompt: str,
        messages: List[Dict[str, Any]],
    ) -> Any:
        """
        Get completions from Claude for the given prompt.

        Args:
            system_prompt: The system prompt for Claude
            messages: The conversation messages for Claude

        Returns:
            Claude's response
        """
        url = f"{self.base_url}{self.messages_endpoint}"

        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": self.anthropic_version,
            "content-type": "application/json",
        }

        payload = {
            "model": self.model,
            "max_tokens": 4000,
            "system": system_prompt,
            "messages": messages,
        }

        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.post(
                    url=url, headers=headers, json=payload
                )
                response.raise_for_status()
                response_data = response.json()

                return response_data.get("content", [{"text": ""}])[0].get("text", "")

        except httpx.HTTPStatusError as e:
            logger.error(
                f"HTTP status error in Anthropic API call: {str(e)} - {e.response.text}"
            )

            if e.response.status_code == 429:
                logger.warning("Rate limit exceeded. Waiting for 70 seconds...")
                await asyncio.sleep(70)
                return await self.completions(
                    system_prompt=system_prompt, messages=messages
                )
            else:
                raise HTTPException(
                    status_code=e.response.status_code,
                    detail=f"Error calling Claude API: {e.response.text}",
                )

        except Exception as e:
            logger.error(f"Error calling Claude API: {str(e)}")
            raise HTTPException(
                status_code=500, detail=f"Error calling Claude API: {str(e)}"
            )

    def _parse_response(self, response: str) -> Dict[str, Any]:
        """
        Parse the response to determine if it's a tool call or a text response.

        Args:
            response: The response text from Claude

        Returns:
            Dict with parsed response information
        """
        # Check if response contains a JSON code block
        json_matches = re.findall(r"```json\s*([\s\S]*?)\s*```", response)
        
        if json_matches:
            try:
                # Parse JSON for tool call
                json_content = json.loads(json_matches[0])
                
                return {
                    "is_tool_call": True,
                    "tool_name": json_content.get("tool_name", ""),
                    "tool_parameters": json_content.get("tool_parameters", {}),
                    "thought": json_content.get("thought", ""),
                    "content": "",
                    "is_end": False
                }
            except (json.JSONDecodeError, IndexError) as e:
                logger.warning(f"Failed to parse JSON from response: {str(e)}")
        
        # Check if response contains "END" to mark completion
        is_end = "END" in response.split("\n")[-1]
        
        # Regular text response
        return {
            "is_tool_call": False,
            "tool_name": "",
            "tool_parameters": {},
            "thought": "",
            "content": response,
            "is_end": is_end
        }
