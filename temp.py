import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Union

import click
import httpx
import mcp.types as types
import uvicorn
from dotenv import load_dotenv
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class LLMToolIntegration:
    def __init__(self, model_name: str = "gpt-4o", api_type: str = "openai"):
        self.model_name = model_name
        self.api_type = api_type.lower()
        self.mcp_session = None
        self.available_tools = []

    async def connect_to_mcp_server(
        self,
        transport_type: str = "sse",
        server_url: str = "http://localhost:8000/sse",
    ):
        """Connect to an MCP server using the specified transport"""
        try:
            if transport_type.lower() == "sse":
                streams = await sse_client(server_url).__aenter__()
                self.mcp_session = ClientSession(streams[0], streams[1])
                await self.mcp_session.__aenter__()
                await self.mcp_session.initialize()
            elif transport_type.lower() == "stdio":
                streams = await stdio_client().__aenter__()
                self.mcp_session = ClientSession(streams[0], streams[1])
                await self.mcp_session.__aenter__()
                await self.mcp_session.initialize()
            else:
                raise ValueError(
                    f"Unsupported transport type: {transport_type}"
                )

            # Fetch available tools from the server
            self.available_tools = await self.mcp_session.list_tools()
            logger.info(
                f"Connected to MCP server. Available tools: {[tool.name for tool in self.available_tools]}"
            )
            return True
        except Exception as e:
            logger.error(f"Failed to connect to MCP server: {str(e)}")
            return False

    async def call_tool(
        self, tool_name: str, arguments: Dict[str, Any]
    ) -> List[
        Union[types.TextContent, types.ImageContent, types.EmbeddedResource]
    ]:
        """Call a tool from the MCP server"""
        if not self.mcp_session:
            raise ValueError("Not connected to an MCP server")

        # Check if the tool exists
        tool_exists = any(
            tool.name == tool_name for tool in self.available_tools
        )
        if not tool_exists:
            raise ValueError(f"Tool '{tool_name}' not found in available tools")

        # Call the tool
        logger.info(f"Calling tool '{tool_name}' with arguments: {arguments}")
        result = await self.mcp_session.call_tool(tool_name, arguments)
        return result

    async def process_user_query(self, query: str) -> Dict[str, Any]:
        """Process a user query using the LLM and potentially MCP tools"""
        system_message = """
        You are an assistant that can use external tools when needed.
        You have access to the following tools:
        
        {tool_descriptions}
        
        When a user asks a question:
        1. If the question requires using one of the available tools, use it
        2. If no tools are needed, respond directly
        3. Always explain your reasoning before deciding to use a tool
        """

        # Format tool descriptions
        tool_descriptions = "\n".join(
            [
                f"{tool.name}: {tool.description}"
                for tool in self.available_tools
            ]
        )

        system_message = system_message.format(
            tool_descriptions=tool_descriptions
        )

        messages = [
            {"role": "system", "content": system_message},
            {"role": "user", "content": query},
        ]

        # First call to the LLM to determine if a tool is needed
        if self.api_type == "openai":
            response = await self.openai_api_call(
                model_name=self.model_name,
                messages=messages,
                tools=[
                    self.convert_mcp_tool_to_openai_tool(tool)
                    for tool in self.available_tools
                ],
            )
        elif self.api_type == "anthropic":
            response = await self.anthropic_api_call(
                model_name=self.model_name,
                messages=messages,
                tools=[
                    self.convert_mcp_tool_to_anthropic_tool(tool)
                    for tool in self.available_tools
                ],
            )
        else:
            return {"message": f"Unsupported API type: {self.api_type}"}

        if response is None:
            return {
                "message": f"An error occurred while calling the {self.api_type.upper()} API"
            }

        # Process the response and check if a tool was called
        if self.api_type == "openai":
            return await self.process_openai_response(response, messages, query)
        elif self.api_type == "anthropic":
            return await self.process_anthropic_response(
                response, messages, query
            )

    def convert_mcp_tool_to_openai_tool(
        self, tool: types.Tool
    ) -> Dict[str, Any]:
        """Convert an MCP tool to OpenAI tool format"""
        return {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.inputSchema,
            },
        }

    def convert_mcp_tool_to_anthropic_tool(
        self, tool: types.Tool
    ) -> Dict[str, Any]:
        """Convert an MCP tool to Anthropic tool format"""
        return {
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.inputSchema,
        }

    async def openai_api_call(
        self,
        model_name: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        **params,
    ):
        """Call the OpenAI API"""
        url = "https://api.openai.com/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": model_name,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            **params,
        }

        try:
            async with httpx.AsyncClient(verify=False, timeout=100) as client:
                s = time.perf_counter()
                response = await client.post(
                    url=url, headers=headers, json=payload
                )
                e = time.perf_counter()
                response_time = e - s
                response.raise_for_status()
                response_data = response.json()
                response_data["response_time"] = response_time
                logger.debug(json.dumps(response_data, indent=4))
                return response_data
        except Exception as e:
            logger.error(f"Error in OpenAI API call: {str(e)}")
            return None

    async def anthropic_api_call(
        self,
        model_name: str,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        **params,
    ):
        """Call the Anthropic API"""
        url = "https://api.anthropic.com/v1/messages"

        headers = {
            "x-api-key": os.getenv("ANTHROPIC_API_KEY"),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        # Convert messages to Anthropic format
        anthropic_messages = []
        system_content = ""

        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
                content = []
                if "content" in msg and msg["content"]:
                    content.append({"type": "text", "text": msg["content"]})

                if msg["role"] == "tool" and "tool_call_id" in msg:
                    # For tool responses
                    anthropic_messages.append(
                        {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": msg["tool_call_id"],
                                    "content": [
                                        {"type": "text", "text": msg["content"]}
                                    ],
                                }
                            ],
                        }
                    )
                    continue

                anthropic_messages.append(
                    {
                        "role": (
                            "user" if msg["role"] == "user" else "assistant"
                        ),
                        "content": content,
                    }
                )

        payload = {
            "model": model_name,
            "messages": anthropic_messages,
            "system": system_content,
            "max_tokens": 4096,
            "tools": tools,
            **params,
        }

        try:
            async with httpx.AsyncClient(verify=False, timeout=100) as client:
                s = time.perf_counter()
                response = await client.post(
                    url=url, headers=headers, json=payload
                )
                e = time.perf_counter()
                response_time = e - s
                response.raise_for_status()
                response_data = response.json()
                response_data["response_time"] = response_time
                logger.debug(json.dumps(response_data, indent=4))
                return response_data
        except Exception as e:
            logger.error(f"Error in Anthropic API call: {str(e)}")
            return None

    async def process_openai_response(
        self,
        response: Dict[str, Any],
        messages: List[Dict[str, Any]],
        original_query: str,
    ) -> Dict[str, Any]:
        """Process the OpenAI API response and handle tool calls if present"""
        assistant_message = response["choices"][0]["message"]

        # If no tool calls, return the response directly
        if "tool_calls" not in assistant_message:
            return {"message": assistant_message.get("content", "")}

        # Process tool calls
        tool_calls = assistant_message["tool_calls"]
        updated_messages = messages.copy()
        updated_messages.append(assistant_message)

        for tool_call in tool_calls:
            tool_call_id = tool_call["id"]
            function_name = tool_call["function"]["name"]
            function_args = json.loads(tool_call["function"]["arguments"])

            # Call the actual MCP tool
            try:
                tool_result = await self.call_tool(function_name, function_args)

                # Convert MCP tool result to text
                if tool_result:
                    tool_content = "\n".join(
                        [
                            (
                                content.text
                                if hasattr(content, "text")
                                else str(content)
                            )
                            for content in tool_result
                        ]
                    )
                else:
                    tool_content = "No result from tool"

                # Add tool result to messages
                updated_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": tool_content,
                    }
                )

                logger.info(f"Tool {function_name} called successfully")
            except Exception as e:
                error_message = f"Error calling tool {function_name}: {str(e)}"
                logger.error(error_message)
                updated_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": error_message,
                    }
                )

        # Make a second call to the model with the tool results
        second_response = await self.openai_api_call(
            model_name=self.model_name,
            messages=updated_messages,
            tools=[
                self.convert_mcp_tool_to_openai_tool(tool)
                for tool in self.available_tools
            ],
        )

        if second_response is None:
            return {
                "message": "An error occurred while processing the tool results"
            }

        final_message = second_response["choices"][0]["message"].get(
            "content", ""
        )

        return {
            "message": final_message,
            "tool_used": (
                function_name if "tool_calls" in assistant_message else None
            ),
        }

    async def process_anthropic_response(
        self,
        response: Dict[str, Any],
        messages: List[Dict[str, Any]],
        original_query: str,
    ) -> Dict[str, Any]:
        """Process the Anthropic API response and handle tool calls if present"""
        # Check if there's a tool use in the response
        has_tool_use = False
        tool_used = None

        for content_item in response["content"]:
            if content_item["type"] == "tool_use":
                has_tool_use = True
                tool_use = content_item
                tool_use_id = tool_use["id"]
                tool_name = tool_use["name"]
                tool_params = tool_use["input"]
                tool_used = tool_name

                # Call the actual MCP tool
                try:
                    tool_result = await self.call_tool(tool_name, tool_params)

                    # Convert MCP tool result to text
                    if tool_result:
                        tool_content = "\n".join(
                            [
                                (
                                    content.text
                                    if hasattr(content, "text")
                                    else str(content)
                                )
                                for content in tool_result
                            ]
                        )
                    else:
                        tool_content = "No result from tool"

                    # Convert messages to Anthropic format for second call
                    anthropic_messages = []
                    system_content = ""

                    for msg in messages:
                        if msg["role"] == "system":
                            system_content = msg["content"]
                        else:
                            anthropic_messages.append(
                                {
                                    "role": (
                                        "user"
                                        if msg["role"] == "user"
                                        else "assistant"
                                    ),
                                    "content": [
                                        {"type": "text", "text": msg["content"]}
                                    ],
                                }
                            )

                    # Add the assistant response with tool use
                    anthropic_messages.append(
                        {"role": "assistant", "content": response["content"]}
                    )

                    # Add the tool result
                    anthropic_messages.append(
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": tool_use_id,
                                    "content": [
                                        {"type": "text", "text": tool_content}
                                    ],
                                }
                            ],
                        }
                    )

                    # Make a second call with the tool result
                    second_response = await self.anthropic_api_call(
                        model_name=self.model_name,
                        messages=anthropic_messages,
                        tools=[
                            self.convert_mcp_tool_to_anthropic_tool(tool)
                            for tool in self.available_tools
                        ],
                        system=system_content,
                    )

                    if second_response is None:
                        return {
                            "message": "An error occurred while processing the tool results"
                        }

                    # Extract message text from Anthropic's response format
                    # Extract message text from Anthropic's response format
                    final_message = ""
                    for content_item in second_response["content"]:
                        if content_item["type"] == "text":
                            final_message += content_item["text"]

                    return {"message": final_message, "tool_used": tool_name}

                except Exception as e:
                    error_message = f"Error calling tool {tool_name}: {str(e)}"
                    logger.error(error_message)
                    return {"message": error_message}

        # If no tool was used, extract and return the text response
        if not has_tool_use:
            message_text = ""
            for content_item in response["content"]:
                if content_item["type"] == "text":
                    message_text += content_item["text"]

            return {"message": message_text, "tool_used": None}


async def setup_web_server(port: int = 8000):
    """Set up a web server to handle user queries"""

    # Initialize the LLM Tool Integration
    llm_integration = LLMToolIntegration(model_name="gpt-4o", api_type="openai")

    # Connect to MCP server in the background
    async def startup():
        connected = await llm_integration.connect_to_mcp_server()
        if not connected:
            logger.error(
                "Failed to connect to MCP server. Make sure your MCP server is running."
            )

    # Handle user queries
    async def handle_query(request: Request):
        data = await request.json()
        query = data.get("query")
        if not query:
            return JSONResponse({"error": "Missing query parameter"})

        # Process the query with the LLM and potentially MCP tools
        result = await llm_integration.process_user_query(query)
        return JSONResponse(result)

    # Create Starlette app
    app = Starlette(
        debug=True,
        routes=[
            Route("/query", endpoint=handle_query, methods=["POST"]),
        ],
        on_startup=[startup],
    )

    # Run with Uvicorn
    uvicorn.run(app, host="0.0.0.0", port=port)


# ... keep all previous code unchanged ...


@click.command()
@click.option("--port", default=8000, help="Port to listen on for web server")
@click.option("--model", default="gpt-4o", help="LLM model to use")
@click.option(
    "--api", default="openai", help="API type to use (openai or anthropic)"
)
@click.option(
    "--transport", default="sse", help="MCP transport type (sse or stdio)"
)
@click.option(
    "--mcp-url",
    default="http://localhost:8001/sse",
    help="MCP server URL for SSE transport",
)
def main_wrapper(port: int, model: str, api: str, transport: str, mcp_url: str):
    """Wrapper function to run the async main function"""
    asyncio.run(main(port, model, api, transport, mcp_url))


async def main(
    port: int, model: str, api: str, transport: str, mcp_url: str
) -> int:
    """Main entry point for the LLM Tool Integration"""

    # Initialize the LLM Tool Integration
    llm_integration = LLMToolIntegration(model_name=model, api_type=api)

    # Connect to MCP server
    logger.info(f"Connecting to MCP server using {transport} transport...")
    connected = await llm_integration.connect_to_mcp_server(
        transport_type=transport, server_url=mcp_url
    )

    if not connected:
        logger.error(
            "Failed to connect to MCP server. Make sure your MCP server is running."
        )
        return 1

    # Interactive CLI mode
    if transport == "stdio":
        logger.info("Starting interactive CLI mode...")
        try:
            while True:
                query = input("\nEnter your query (or 'exit' to quit): ")
                if query.lower() in ("exit", "quit"):
                    break

                result = await llm_integration.process_user_query(query)
                logging.info("\nResponse:")
                logging.info(result["message"])
                if result.get("tool_used"):
                    logging.info(f"\n(Tool used: {result['tool_used']})")
        except KeyboardInterrupt:
            logger.info("Exiting...")
        return 0

    # Web server mode
    logger.info(f"Starting web server on port {port}...")
    await setup_web_server(port=port)
    return 0


if __name__ == "__main__":
    # Use the wrapper function with click instead of trying to run the async function directly
    main_wrapper()
