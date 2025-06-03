import asyncio
import json
import logging
import os
import sys
from typing import Any, Dict, List

import httpx
from config.settings import settings
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from memory.agent_memory import AgentMemory
from prompts.coding_agent_prompt import CODING_AGENT_SYSTEM_PROMPT


class AnthropicAgent:
    MAX_TOOL_CALL_DEPTH = 100  # Prevent infinite recursion
    MAX_RETRIES = 3

    def __init__(self, model_name="claude-sonnet-4-20250514"):
        self.model_name = model_name
        self.agent_memory = AgentMemory()
        self.session = None
        self.client_context = None
        self.anthropic_tools = []

    async def anthropic_api_call(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        **params,
    ):
        """Call the Anthropic API"""
        url = settings.ANTHROPIC_BASE_URL

        headers = {
            "x-api-key": settings.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        # Convert OpenAI tool format to Anthropic tool format
        anthropic_tools = []
        for tool in tools:
            if tool.get("type") == "function":
                function_info = tool.get("function", {})
                anthropic_tools.append(
                    {
                        "name": function_info.get("name", ""),
                        "description": function_info.get("description", ""),
                        "input_schema": function_info.get("parameters", {}),
                    }
                )

        # Extract system message if present
        system_content = None
        for message in messages:
            if message.get("role") == "system":
                system_content = message.get("content")
                if isinstance(system_content, str):
                    # If it's a string, it's already in the correct format
                    pass
                elif isinstance(system_content, list):
                    # If content is a list of blocks, extract text from text blocks
                    system_text = ""
                    for block in system_content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "text"
                        ):
                            system_text += block.get("text", "")
                    system_content = system_text
                break

        # Prepare normal messages, skipping system message
        anthropic_messages = []
        for message in messages:
            if message.get("role") != "system":
                anthropic_messages.append(message)

        payload = {
            "model": self.model_name,
            "max_tokens": params.get("max_tokens", 1024),
            "tools": anthropic_tools,
            "messages": anthropic_messages,
        }

        # Add system parameter if we have a system message
        if system_content:
            payload["system"] = system_content

        try:
            async with httpx.AsyncClient(verify=False, timeout=100) as client:
                response = await client.post(
                    url=url, headers=headers, json=payload
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as e:
            print(f"Error in Anthropic API: {e.response.text} - {str(e)}")
            return None
        except httpx.RequestError as e:
            print(f"Request Error in Anthropic API call: {str(e)}")
            return None
        except httpx.HTTPError as e:
            print(f"Error in Anthropic API call HTTPError: {str(e)}")
            return None
        except Exception as e:
            print(f"Error in Anthropic API call: {str(e)}")
            return None

    async def process_tool_calls(self, assistant_message, depth=0):
        """
        Process tool calls recursively, allowing the model to make multiple tool calls
        until it provides a final answer. Updates agent memory with all actions taken.
        """
        if depth >= self.MAX_TOOL_CALL_DEPTH:
            return {
                "message": "Maximum tool call depth reached. Stopping to prevent infinite loops."
            }, self.agent_memory

        # Extract content blocks from Anthropic response
        content_blocks = assistant_message.get("content", [])
        has_tool_calls = False
        tool_calls = []

        # Check for tool_use blocks in the content
        for block in content_blocks:
            if block.get("type") == "tool_use":
                has_tool_calls = True
                tool_calls.append(block)

        # If no tool calls, just return the text response
        if not has_tool_calls:
            # Extract text from content blocks
            text_content = ""
            for block in content_blocks:
                if block.get("type") == "text":
                    text_content += block.get("text", "")

            # Add the assistant's final response to memory
            self.agent_memory.add_assistant_message(assistant_message)
            return {"message": text_content}, self.agent_memory

        # Add the assistant message with tool calls to memory
        self.agent_memory.add_assistant_message(assistant_message)

        # Process each tool call
        for tool_call in tool_calls:
            tool_use_id = tool_call.get("id")
            tool_name = tool_call.get("name")
            tool_input = tool_call.get("input", {})

            # Add a permission check for run_terminal_cmd
            if tool_name == "run_terminal_cmd":
                command = tool_input.get("command", "")
                print("\n=================================================")
                print("PERMISSION REQUIRED")
                print("=================================================")
                print(f"The agent wants to run the following terminal command:")
                print(f"{command}")
                print("=================================================")

                permission = (
                    input("Do you want to allow this command? (yes/no): ")
                    .strip()
                    .lower()
                )
                if permission not in ["yes", "y"]:
                    # If permission denied, skip this tool call and notify the agent
                    print("Permission denied for running terminal command.")
                    tool_content = "ERROR: Permission denied for running terminal command. The user did not approve this command execution."
                    self.agent_memory.add_tool_call(tool_call, tool_content)
                    self.agent_memory.add_tool_result(tool_use_id, tool_content)
                    continue

            print(f"\nUsing tool: {tool_name}")
            print(f"With arguments: {json.dumps(tool_input, indent=2)}")

            # Call the MCP tool
            try:
                tool_result = await self.session.call_tool(
                    tool_name, tool_input
                )
                print(f"tool_result: {tool_result}")

                # Process result
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

                    # Limit content length to avoid issues with very large inputs
                    original_length = len(tool_content)
                    if original_length > 32000:  # Adjust threshold as needed
                        tool_content = (
                            tool_content[:32000]
                            + f"\n[Content truncated from {original_length} to 32000 characters]"
                        )
                        print(
                            f"Truncated tool result from {original_length} to 32000 characters"
                        )
                else:
                    tool_content = "No result from tool"
                    logging.info(
                        f"No response got from the tool might have error while using the tool"
                    )

                # Record the tool call and result in agent memory
                self.agent_memory.add_tool_call(tool_call, tool_content)
                self.agent_memory.add_tool_result(tool_use_id, tool_content)

                print(
                    f"Tool result retrieved (length: {len(tool_content)} characters)"
                )
            except Exception as e:
                error_message = f"Error calling tool {tool_name}: {str(e)}"
                print(error_message)
                # Still record the attempt in memory
                self.agent_memory.add_tool_call(tool_call, f"ERROR: {str(e)}")
                self.agent_memory.add_tool_result(tool_use_id, error_message)

        # Make next call to Anthropic with tool results
        print(f"Generating response after tool calls (depth {depth})...")
        next_response = await self.anthropic_api_call(
            messages=self.agent_memory.get_conversation_messages(),
            tools=self.anthropic_tools,
        )

        if not next_response:
            final_message = {
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": "Error: Couldn't get a response from the LLM after tool calls.",
                    }
                ],
            }
            self.agent_memory.add_assistant_message(final_message)
            return {
                "message": "Error: Couldn't get a response from the LLM after tool calls."
            }, self.agent_memory

        next_assistant_message = {
            "role": "assistant",
            "content": next_response.get("content", []),
        }

        # Check if this message has more tool calls
        has_more_tool_calls = any(
            block.get("type") == "tool_use"
            for block in next_response.get("content", [])
        )

        if has_more_tool_calls:
            print(
                f"\nLLM is making additional tool calls (depth {depth + 1})..."
            )
            return await self.process_tool_calls(
                next_assistant_message, depth + 1
            )

        # If we get here, the LLM provided a final response with no more tool calls
        self.agent_memory.add_assistant_message(next_assistant_message)

        # Extract text from content blocks for the final response
        final_response = ""
        for block in next_response.get("content", []):
            if block.get("type") == "text":
                final_response += block.get("text", "")

        return {"message": final_response}, self.agent_memory

    async def initialize_session(self, server_url, transport_type):
        """Initialize the MCP session and connect to the server"""
        try:
            # Connect to MCP server
            if transport_type.lower() == "sse":
                self.client_context = sse_client(server_url)
                streams = await self.client_context.__aenter__()
            else:  # stdio
                self.client_context = stdio_client()
                streams = await self.client_context.__aenter__()

            # Create client session
            self.session = ClientSession(streams[0], streams[1])
            await self.session.__aenter__()
            await self.session.initialize()
            print("Connected to MCP server successfully!")

            # Get available tools
            tools = await self.session.list_tools()

            if not tools or not hasattr(tools, "tools") or not tools.tools:
                print("No tools available from the MCP server.")
                return False

            print(
                f"Available tools: {', '.join([tool.name for tool in tools.tools])}"
            )

            # Convert MCP tools to Anthropic format
            self.anthropic_tools = []
            for tool in tools.tools:
                self.anthropic_tools.append(
                    {
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.inputSchema,
                        },
                    }
                )

            # Create system message with tool descriptions and agentic capabilities
            tool_descriptions = "\n".join(
                [f"{tool.name}: {tool.description}" for tool in tools.tools]
            )
            system_message = CODING_AGENT_SYSTEM_PROMPT.format(
                tool_descriptions=tool_descriptions,
                user_workspace=os.path.abspath("codebase"),
            )
            # Initialize agent memory with system message
            print(f"System message: {system_message}")
            self.agent_memory.initialize_with_system_message(system_message)
            return True

        except Exception as e:
            print(f"Error initializing session: {str(e)}")
            return False

    async def run_interactive_session(
        self,
        server_url: str = "http://0.0.0.0:8001/sse",
        transport_type: str = "sse",
    ):
        """Run an interactive session with the LLM using MCP tools with agent memory"""
        print(
            f"Connecting to MCP server using {transport_type} transport at {server_url}..."
        )

        try:
            # Initialize the session
            if not await self.initialize_session(server_url, transport_type):
                return

            # Interactive loop
            while True:
                # Get user query
                user_query = input("\nEnter your query (or 'exit' to quit): ")
                if user_query.lower() in ("exit", "quit"):
                    break

                # Process the user query
                enhanced_query = user_query

                # Add internal agent memory context
                tool_usage_summary = self.agent_memory.get_tool_usage_summary()
                if self.agent_memory.total_tool_calls > 0:
                    memory_context = f"\n--- Agent Memory Reflection ---\n{tool_usage_summary}\n--- End Memory Reflection ---\n\n"
                    enhanced_query = f"{memory_context}{enhanced_query}"

                # Add the user message to agent memory
                self.agent_memory.add_user_message(enhanced_query)

                # First call to Anthropic with full conversation history
                print("Thinking...")
                response = await self.anthropic_api_call(
                    messages=self.agent_memory.get_conversation_messages(),
                    tools=self.anthropic_tools,
                )

                if not response:
                    print("Error: Couldn't get a response from the LLM.")
                    # Add error message to memory
                    self.agent_memory.add_assistant_message(
                        {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "I encountered an error and couldn't process your request.",
                                }
                            ],
                        }
                    )
                    continue

                assistant_message = {
                    "role": "assistant",
                    "content": response.get("content", []),
                }

                # Process the message - either direct answer or tool calls
                result, updated_agent_memory = await self.process_tool_calls(
                    assistant_message
                )

                # Update our agent memory with the results
                self.agent_memory = updated_agent_memory

                print("\nFinal Response:")
                print(result["message"])

        except KeyboardInterrupt:
            print("\nExiting due to keyboard interrupt...")
        except Exception as e:
            print(f"\nError in interactive session: {str(e)}")
            import traceback

            traceback.print_exc()
        finally:
            # Properly clean up resources
            await self.cleanup()

    async def cleanup(self):
        """Clean up resources before exiting"""
        if self.session:
            try:
                await self.session.__aexit__(None, None, None)
            except Exception as e:
                print(f"Error closing session: {str(e)}")

        if self.client_context:
            try:
                await self.client_context.__aexit__(None, None, None)
            except Exception as e:
                print(f"Error closing client context: {str(e)}")

    @classmethod
    async def main_async(
        cls,
        server_url: str = settings.MCP_BASE_URL,
        transport_type: str = "sse",
    ):
        agent = cls()
        await agent.run_interactive_session(server_url, transport_type)

    @classmethod
    def main(cls):
        # Get transport type from command line args
        transport = "sse"
        server_url = settings.MCP_BASE_URL

        if len(sys.argv) > 1:
            transport = sys.argv[1]

        if len(sys.argv) > 2:
            server_url = sys.argv[2]

        print(
            f"Starting Anthropic agentic assistant - connecting to MCP server at {server_url} using {transport} transport"
        )
        asyncio.run(cls.main_async(server_url, transport))


if __name__ == "__main__":
    AnthropicAgent.main()
