import asyncio
import json
import os
import sys
import time
from datetime import datetime
from logging import getLogger
from typing import Any, Dict, List

import httpx
from config.settings import settings
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from memory.agent_memory import AgentMemory
from motor.motor_asyncio import AsyncIOMotorClient
from prompts.coding_agent_prompt import CODING_AGENT_SYSTEM_PROMPT
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.syntax import Syntax
from rich.table import Table
from rich.theme import Theme

logger = getLogger(__name__)


# Custom Rich theme
custom_theme = Theme(
    {
        "info": "cyan",
        "warning": "yellow",
        "error": "bold red",
        "success": "bold green",
        "tool": "bold magenta",
        "user": "bold blue",
        "assistant": "green",
        "tool_result": "dim white",
        "thinking": "yellow",
    }
)

# Create console with custom theme
console = Console(theme=custom_theme)


class AnthropicAgent:
    MAX_TOOL_CALL_DEPTH = 30  # Prevent infinite recursion
    MAX_RETRIES = 3

    def __init__(self, model_name="claude-3-7-sonnet-20250219"):
        self.model_name = model_name
        self.agent_memory = AgentMemory()
        self.session = None
        self.client_context = None
        self.anthropic_tools = []
        self.timeout = httpx.Timeout(
            connect=60.0,  # Time to establish a connection
            read=120.0,  # Time to read the response
            write=120.0,  # Time to send data
            pool=60.0,  # Time to wait for a connection from the pool
        )

        try:
            self.mongodb_client = AsyncIOMotorClient(settings.MONGODB_URL)
            self.llm_usage_collection = self.mongodb_client[
                settings.MONGODB_DB_NAME
            ][settings.LLM_USAGE_COLLECTION_NAME]
        except Exception as e:
            console.print(f"[error]MongoDB connection error: {str(e)}[/error]")
            self.mongodb_client = None
            self.llm_usage_collection = None

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
            start_time = time.time()

            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.post(
                    url=url, headers=headers, json=payload
                )
                response.raise_for_status()
                response_data = response.json()

                # Calculate API call duration
                duration = time.time() - start_time

                # Log API usage to MongoDB
                if (
                    self.mongodb_client is not None
                    and self.llm_usage_collection is not None
                ):
                    try:
                        # Extract usage information
                        usage = response_data.get("usage", {})
                        input_tokens = usage.get("input_tokens", 0)
                        output_tokens = usage.get("output_tokens", 0)
                        cache_creation_input_tokens = usage.get(
                            "cache_creation_input_tokens", 0
                        )
                        cache_read_input_tokens = usage.get(
                            "cache_read_input_tokens", 0
                        )

                        total_tokens = (
                            input_tokens
                            + output_tokens
                            + cache_creation_input_tokens
                            + cache_read_input_tokens
                        )

                        # Create usage log document
                        llm_usage = {
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "total_tokens": total_tokens,
                            "cache_creation_input_tokens": cache_creation_input_tokens,
                            "cache_read_input_tokens": cache_read_input_tokens,
                            "duration": duration,
                            "provider": "Anthropic",
                            "model": self.model_name,
                            "created_at": datetime.utcnow(),
                            "request_id": response_data.get("id", "unknown"),
                            "request_type": "chat",
                        }

                        # Log asynchronously without waiting for completion
                        await self.llm_usage_collection.insert_one(llm_usage)
                    except Exception as log_error:
                        console.print(
                            f"[warning]Failed to log API usage: {str(log_error)}[/warning]"
                        )

                return response_data
        except httpx.HTTPStatusError as e:
            console.print(
                f"[error]Error in Anthropic API: {e.response.text} - {str(e)}[/error]"
            )
            return None
        except httpx.RequestError as e:
            console.print(
                f"[error]Request Error in Anthropic API call: {str(e)}[/error]"
            )
            return None
        except httpx.HTTPError as e:
            console.print(
                f"[error]Error in Anthropic API call HTTPError: {str(e)}[/error]"
            )
            return None
        except Exception as e:
            console.print(
                f"[error]Error in Anthropic API call: {str(e)}[/error]"
            )
            return None

    async def process_tool_calls(self, assistant_message, depth=0):
        """
        Process tool calls recursively, allowing the model to make multiple tool calls
        until it provides a final answer. Updates agent memory with all actions taken.
        """
        if depth >= self.MAX_TOOL_CALL_DEPTH:
            console.print(
                Panel(
                    "Maximum tool call depth reached. Stopping to prevent infinite loops.",
                    title="[error]Error[/error]",
                    border_style="red",
                )
            )
            # Add exit logic when MAX_TOOL_CALL_DEPTH is reached
            await self.cleanup()
            console.print(
                "[success]Session ended due to reaching MAX_TOOL_CALL_DEPTH[/success]"
            )
            sys.exit(0)

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

            # Check if total tool calls will exceed 25
            if self.agent_memory.total_tool_calls >= 25:
                console.print(
                    Panel(
                        f"[bold yellow]The agent has already made 25 tool calls in this session.[/bold yellow]\nContinuing might lead to longer processing times.",
                        title="[warning]Tool Call Limit Reached[/warning]",
                        border_style="yellow",
                    )
                )
                permission = (
                    input(
                        "Do you want to continue with more tool calls? (yes/no): "
                    )
                    .strip()
                    .lower()
                )
                if permission not in ["yes", "y"]:
                    # If user doesn't want to continue, clean up and exit
                    console.print(
                        "[info]Stopping further tool calls as requested.[/info]"
                    )
                    await self.cleanup()
                    console.print("[success]Session ended by user[/success]")
                    sys.exit(0)

            # Extract thinking text if present (looking for text blocks before this tool call)
            thinking_text = ""
            tool_index = content_blocks.index(tool_call)
            # Check if there's a text block immediately before this tool call
            if (
                tool_index > 0
                and content_blocks[tool_index - 1].get("type") == "text"
            ):
                text_block = content_blocks[tool_index - 1]
                raw_text = text_block.get("text", "")
                # Check if the text is enclosed in <thinking> tags
                if "<thinking>" in raw_text and "</thinking>" in raw_text:
                    thinking_text = raw_text.split("<thinking>")[1].split(
                        "</thinking>"
                    )[0]
                else:
                    thinking_text = raw_text

            # Add a permission check for run_terminal_cmd
            if tool_name == "run_terminal_command":
                command = tool_input.get("command", "")
                console.print(
                    Panel(
                        f"[bold yellow]The agent wants to run the following terminal command:[/bold yellow]\n[bold]{command}[/bold]",
                        title="[warning]Permission Required[/warning]",
                        border_style="yellow",
                    )
                )

                permission = (
                    input("Do you want to allow this command? (yes/no): ")
                    .strip()
                    .lower()
                )
                if permission not in ["yes", "y"]:
                    # If permission denied, skip this tool call and notify the agent
                    console.print(
                        "[error]Permission denied for running terminal command.[/error]"
                    )
                    tool_content = "ERROR: Permission denied for running terminal command. The user did not approve this command execution."
                    self.agent_memory.add_tool_call(tool_call, tool_content)
                    self.agent_memory.add_tool_result(tool_use_id, tool_content)
                    continue

            # Display thinking if available
            if thinking_text:
                console.print()
                console.print(
                    Panel(
                        thinking_text,
                        title="[thinking]Assistant's Reasoning[/thinking]",
                        border_style="yellow",
                    )
                )

            # Create a nice panel for the tool call
            console.print()
            console.print(
                Panel(
                    f"[bold]Arguments:[/bold]\n{json.dumps(tool_input, indent=2)}",
                    title=f"[tool]Using Tool: {tool_name}[/tool]",
                    border_style="magenta",
                )
            )

            # Call the MCP tool with a spinner
            try:
                with console.status(
                    f"[thinking]Executing {tool_name}...[/thinking]"
                ):
                    # Check if session exists before calling
                    if not self.session:
                        raise Exception("Session is not initialized")
                    tool_result = await self.session.call_tool(
                        tool_name, tool_input
                    )

                # Process result
                if tool_result:
                    # Fix content.text access to handle different result types
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
                        console.print(
                            f"[warning]Truncated tool result from {original_length} to 32000 characters[/warning]"
                        )
                else:
                    tool_content = "No result from tool"
                    logger.info(
                        f"No response got from the tool might have error while using the tool"
                    )

                # Record the tool call and result in agent memory
                self.agent_memory.add_tool_call(tool_call, tool_content)
                self.agent_memory.add_tool_result(tool_use_id, tool_content)

                # Display the result in a nice format (syntax highlighting if it looks like code)
                if tool_content.strip().startswith(("{", "[", "<", "```")):
                    # Likely JSON or code - use syntax highlighting
                    console.print(
                        Panel(
                            Syntax(
                                tool_content,
                                (
                                    "python"
                                    if tool_content.strip().startswith(
                                        "```python"
                                    )
                                    else "json"
                                ),
                                theme="monokai",
                                word_wrap=True,
                            ),
                            title="[success]Tool Result[/success]",
                            border_style="green",
                        )
                    )
                else:
                    # Plain text result
                    console.print(
                        Panel(
                            tool_content,
                            title="[success]Tool Result[/success]",
                            border_style="green",
                        )
                    )

                console.print(
                    f"[tool_result]Result length: {len(tool_content)} characters[/tool_result]"
                )
            except Exception as e:
                error_message = f"Error calling tool {tool_name}: {str(e)}"
                console.print(f"[error]{error_message}[/error]")
                # Still record the attempt in memory
                self.agent_memory.add_tool_call(tool_call, f"ERROR: {str(e)}")
                self.agent_memory.add_tool_result(tool_use_id, error_message)

        # Make next call to Anthropic with tool results
        console.print()
        console.print(
            f"[thinking]Generating response after tool calls (depth {depth})...[/thinking]"
        )

        with console.status("[thinking]Thinking...[/thinking]"):
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
            console.print(
                Panel(
                    "Couldn't get a response from the LLM after tool calls.",
                    title="[error]Error[/error]",
                    border_style="red",
                )
            )
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
            console.print(
                f"[info]The agent is making additional tool calls (depth {depth + 1})...[/info]"
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
            with console.status(
                f"[info]Connecting to MCP server via {transport_type}...[/info]"
            ):
                if transport_type.lower() == "sse":
                    self.client_context = sse_client(server_url)
                    streams = await self.client_context.__aenter__()
                else:  # stdio
                    # Fix missing server parameter
                    self.client_context = stdio_client(server=server_url)
                    streams = await self.client_context.__aenter__()

                # Create client session
                self.session = ClientSession(streams[0], streams[1])
                await self.session.__aenter__()
                await self.session.initialize()

            console.print(
                "[success]✓ Connected to MCP server successfully![/success]"
            )

            # Get available tools
            with console.status("[info]Loading available tools...[/info]"):
                tools = await self.session.list_tools()

            if not tools or not hasattr(tools, "tools") or not tools.tools:
                console.print(
                    "[error]No tools available from the MCP server.[/error]"
                )
                return False

            # Create a nice table to display available tools
            table = Table(title="Available Tools", border_style="bright_cyan")
            table.add_column("Tool Name", style="cyan")
            table.add_column("Description", style="green")

            for tool in tools.tools:
                table.add_row(tool.name, tool.description)

            console.print(table)

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
            console.print("[info]Initializing agent system prompt[/info]")
            self.agent_memory.initialize_with_system_message(system_message)
            return True

        except Exception as e:
            console.print(
                f"[error]Error initializing session: {str(e)}[/error]"
            )
            return False

    async def run_interactive_session(
        self,
        server_url: str = "http://0.0.0.0:8001/sse",
        transport_type: str = "sse",
    ):
        """Run an interactive session with the LLM using MCP tools with agent memory"""
        # Show a welcome banner
        console.print(
            Panel(
                "[bold]Welcome to the Anthropic Coding Assistant[/bold]\n"
                "Ask coding questions, request code explanations, or get help with your projects.",
                title="[bold]🤖 Anthropic Agent[/bold]",
                border_style="green",
                width=100,
            )
        )

        console.print(
            f"[info]Connecting to MCP server using {transport_type} transport at {server_url}...[/info]"
        )

        try:
            # Initialize the session
            if not await self.initialize_session(server_url, transport_type):
                return

            # Interactive loop
            while True:
                # Get user query with styled prompt
                user_query = Prompt.ask(
                    "\n[user]What can I help you with?[/user]"
                )
                if user_query.lower() in ("exit", "quit"):
                    # Clean up and exit when user types exit or quit
                    console.print("[info]Exiting as requested...[/info]")
                    await self.cleanup()
                    console.print("[success]Session ended[/success]")
                    sys.exit(0)

                # Add user message to the conversation visually
                console.print(
                    Panel(
                        user_query,
                        title="[user]You[/user]",
                        border_style="blue",
                    )
                )

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
                with console.status("[thinking]Thinking...[/thinking]"):
                    response = await self.anthropic_api_call(
                        messages=self.agent_memory.get_conversation_messages(),
                        tools=self.anthropic_tools,
                    )

                if not response:
                    console.print(
                        Panel(
                            "I encountered an error and couldn't process your request.",
                            title="[error]Error[/error]",
                            border_style="red",
                        )
                    )
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

                # Display the final response in a nicely formatted way
                # Check if response looks like markdown and render accordingly
                response_text = result["message"]
                if (
                    "```" in response_text
                    or "#" in response_text
                    or "*" in response_text
                ):
                    # Likely markdown content
                    console.print(
                        Panel(
                            Markdown(response_text),
                            title="[assistant]Assistant[/assistant]",
                            border_style="green",
                        )
                    )
                else:
                    # Regular text content
                    console.print(
                        Panel(
                            response_text,
                            title="[assistant]Assistant[/assistant]",
                            border_style="green",
                        )
                    )

        except KeyboardInterrupt:
            console.print(
                "\n[warning]Exiting due to keyboard interrupt...[/warning]"
            )
        except Exception as e:
            console.print(
                f"\n[error]Error in interactive session: {str(e)}[/error]"
            )
            import traceback

            console.print(
                Syntax(traceback.format_exc(), "python", theme="monokai")
            )
        finally:
            # Properly clean up resources
            with console.status("[info]Cleaning up resources...[/info]"):
                await self.cleanup()
            console.print("[success]Session ended successfully[/success]")

    async def cleanup(self):
        """Clean up resources before exiting"""
        try:
            if self.session:
                try:
                    await self.session.__aexit__(None, None, None)
                except AttributeError as e:
                    # Handle TaskGroup._exceptions AttributeError gracefully
                    if "_exceptions" in str(e):
                        console.print(
                            "[info]Handled known session closure issue[/info]"
                        )
                    else:
                        console.print(
                            f"[error]Session attribute error: {str(e)}[/error]"
                        )
                except Exception as e:
                    console.print(
                        f"[error]Error closing session: {str(e)}[/error]"
                    )

            if self.client_context:
                try:
                    await self.client_context.__aexit__(None, None, None)
                except Exception as e:
                    console.print(
                        f"[error]Error closing client context: {str(e)}[/error]"
                    )
        except Exception as e:
            console.print(f"[error]Error during cleanup: {str(e)}[/error]")

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

        # Create a beautiful startup screen
        console.clear()
        console.print(
            Panel(
                "[bold cyan]Anthropic[/bold cyan] [bold green]Agentic[/bold green] [bold magenta]Assistant[/bold magenta]\n\n"
                "A powerful AI coding assistant with tool-using capabilities\n"
                f"[dim]Server: {server_url}[/dim]\n"
                f"[dim]Transport: {transport}[/dim]",
                title="[bold]🚀 Starting Up[/bold]",
                border_style="bright_blue",
                expand=False,
                padding=(1, 2),
            )
        )

        asyncio.run(cls.main_async(server_url, transport))


if __name__ == "__main__":
    AnthropicAgent.main()
