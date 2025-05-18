import logging
import json
import asyncio
from typing import Dict, Any, List

import httpx
from fastapi import HTTPException

from agent.models.schemas import AgentState, AgentAction
from agent.models.prompts import create_tool_selection_prompt
from agent.config.settings import settings

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
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(connect=60.0, read=300.0, write=300.0, pool=60.0))
        
    async def determine_next_action(self, agent_state: AgentState) -> AgentAction:
        """
        Determine the next action to take based on the current agent state.
        
        Args:
            agent_state: Current state of the agent including conversation history
            
        Returns:
            AgentAction object with details of the next action to take
        """

        messages = create_tool_selection_prompt(agent_state)
        
        # Use the formatted messages directly
        response = await self.completions(
            system_prompt=messages["system"],
            user_prompt=messages["messages"]
        )
        
        return self._parse_claude_response(response)
    
    async def completions(
        self,
        system_prompt: List[Dict[str, Any]],
        user_prompt: List[Dict[str, Any]],
    ) -> Any:
        """
        Get completions from Claude for the given prompt.
        
        Args:
            system_prompt: The system prompt for Claude (formatted as list of content blocks)
            user_prompt: The conversation messages for Claude (formatted as list of messages)
            
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
            "max_tokens": 15000,
            "system": system_prompt,
            "messages": user_prompt,
        }

        try:
            async with httpx.AsyncClient(timeout=settings.TIMEOUT_SECONDS) as client:
                response = await client.post(
                    url=url,
                    headers=headers,
                    json=payload
                )
                response.raise_for_status()
                response_data = response.json()
                
                return response_data
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP status error in Anthropic API call: {str(e)} - {e.response.text}")
            
            if e.response.status_code == 429:
                logger.warning("Rate limit exceeded. Waiting for 70 seconds...")
                await asyncio.sleep(70)
                return await self.completions(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt
                )
            else:
                raise HTTPException(
                    status_code=e.response.status_code,
                    detail=f"Error calling Claude API: {e.response.text}"
                )
                
        except Exception as e:
            logger.error(f"Error calling Claude API: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Error calling Claude API: {str(e)}"
            )
    
    def _parse_claude_response(self, response: Dict[str, Any]) -> AgentAction:
        """
        Parse Claude's response to determine the next action.
        
        Args:
            response: The response from Claude
            
        Returns:
            AgentAction object with details of the next action
        """
        content = response.get("content", [])
        
        text_content = content[0]["text"]
        
        try:
            import re
            json_matches = re.findall(r"```json\s*([\s\S]*?)\s*```", text_content)
            
            if json_matches:
                json_content = json.loads(json_matches[0])
                
                if "tool_calls" in json_content and json_content["tool_calls"]:
                    tool_call = json_content["tool_calls"][0]
                    return AgentAction(
                        action_type="tool_call",
                        tool_name=tool_call.get("tool"),
                        parameters=tool_call.get("args", {}),
                        message=json_content.get("message", "")
                    )
                
                return AgentAction(
                    action_type="final_response",
                    content=json_content.get("message", "")
                )
        except (json.JSONDecodeError, IndexError) as e:
            logger.warning(f"Failed to parse JSON from response: {str(e)}")
        
        # If JSON parsing fails, return the raw text as final response
        return AgentAction(
            action_type="final_response",
            content=text_content
        )
