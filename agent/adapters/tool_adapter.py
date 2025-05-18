import logging
import json
from typing import Dict, List, Any, Optional

import httpx

from agent.models.schemas import ToolCall, ToolResult
from agent.config.settings import settings
from agent.utils.error_handler import handle_tool_execution_error

logger = logging.getLogger(__name__)

class ToolAdapter:
    """
    Adapter for interacting with the tools provided by the MCP server.
    Handles tool discovery and execution.
    """
    
    def __init__(self):
        self.mcp_base_url = settings.MCP_BASE_URL
        self.client = httpx.AsyncClient(timeout=60.0)
        self._available_tools = None
        
    async def initialize(self):
        """
        Initialize the tool adapter by fetching available tools from the MCP server.
        """
        if not self._available_tools:
            await self._fetch_available_tools()
    
    async def _fetch_available_tools(self):
        """
        Fetch the list of available tools from the MCP server.
        """
        try:
            response = await self.client.get(f"{self.mcp_base_url}/tools")
            response.raise_for_status()
            self._available_tools = response.json().get("tools", [])
            logger.info(f"Fetched {len(self._available_tools)} tools from MCP server")
        except Exception as e:
            logger.error(f"Error fetching available tools: {str(e)}")
            # Set a default empty list if fetch fails
            self._available_tools = []
            raise
    
    def get_available_tools(self) -> List[Dict[str, Any]]:
        """
        Get the list of available tools that can be used by the agent.
        
        Returns:
            List of tool definitions in the format expected by Claude
        """
        if not self._available_tools:
            logger.warning("Tools not yet initialized. Returning empty list.")
            return []
            
        # Format the tools in the way expected by Claude
        claude_tools = []
        for tool in self._available_tools:
            claude_tools.append({
                "name": tool["name"],
                "description": tool["description"],
                "input_schema": tool["input_schema"]
            })
            
        return claude_tools
    
    async def execute_tool(self, tool_call: ToolCall) -> ToolResult:
        """
        Execute a tool using the MCP server.
        
        Args:
            tool_call: Details of the tool to execute
            
        Returns:
            The result of the tool execution
        """
        try:
            # Find the tool in available tools to get its endpoint
            tool_info = next(
                (tool for tool in self._available_tools if tool["name"] == tool_call.tool_name),
                None
            )
            
            if not tool_info:
                error_msg = f"Tool '{tool_call.tool_name}' not found in available tools"
                logger.error(error_msg)
                return ToolResult(success=False, content=error_msg, error=error_msg)
            
            # Prepare the request to the MCP server
            endpoint = tool_info.get("endpoint", f"/tools/{tool_call.tool_name}")
            url = f"{self.mcp_base_url}{endpoint}"
            
            # Execute the tool
            response = await self.client.post(
                url,
                json=tool_call.parameters
            )
            response.raise_for_status()
            result_data = response.json()
            
            return ToolResult(
                success=True,
                content=result_data.get("result", "Tool executed successfully but returned no result.")
            )
            
        except Exception as e:
            error_message = handle_tool_execution_error(e, tool_call)
            logger.error(f"Tool execution error for {tool_call.tool_name}: {error_message}")
            return ToolResult(success=False, content=f"Error executing tool: {error_message}")
