"""
CLI interface for the Code Generation Assistant.
This module provides a minimalist command-line interface using Rich for enhanced output.
"""

import asyncio
import os
import sys
import time
from typing import Any, Dict

from prompt_toolkit import PromptSession
from prompt_toolkit.key_binding import KeyBindings
from rich.align import Align
from rich.box import ROUNDED
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

# Add the necessary path to import agent modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agent.adapters.llm_adapter import LLMAdapter
from agent.core.orchestrator import Orchestrator
from agent.models.schemas import UserQuery


class CodeAssistantCLI:
    """Minimalist CLI for the Code Generation Assistant"""

    def __init__(self):
        """Initialize the CLI interface"""
        self.llm_adapter = LLMAdapter()
        self.orchestrator = Orchestrator(self.llm_adapter)
        self.console = Console()
        self.current_session_id = None  # Store the current session ID

    def display_welcome(self):
        """Display a welcome message"""
        self.console.print(
            Panel.fit(
                "[bold blue]Code Generation Assistant[/bold blue]\n"
                "Type your instructions or 'exit'/'end' to quit.",
                border_style="blue",
            )
        )

    def _create_thinking_animation(self, frame: int) -> Panel:
        """Create animated thinking dots"""
        text = Text("Thinking")
        dots = ["⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂", "⠁"]

        for i in range(3):
            dot = dots[(frame + i * 2) % len(dots)]
            text.append(f" {dot}", style="bold cyan")

        return Panel(
            Align.left(text),
            box=ROUNDED,
            border_style="bright_blue",
            title="Processing",
            width=30,
            padding=(0, 1),
        )

    def show_tool_call(self, tool_call: Dict[str, Any], thought: str = ""):
        """Display a tool call with thought process"""
        if thought:
            self.console.print(
                Panel(
                    thought,
                    title="Thought Process",
                    border_style="yellow",
                )
            )

        self.console.print(
            Panel(
                f"[cyan]Tool:[/cyan] {tool_call['name']}\n"
                f"[magenta]Parameters:[/magenta] {tool_call['parameters']}",
                title="Tool Call",
                border_style="blue",
            )
        )

    def show_assistant_message(self, message: Dict[str, Any]):
        """Display an assistant message"""
        if message.get("content"):
            self.console.print(
                Panel(
                    message["content"],
                    title="Assistant",
                    border_style="green",
                )
            )

    def show_tool_result(self, message: Dict[str, Any]):
        """Display a tool result"""
        self.console.print(
            Panel(
                f"[cyan]Tool Result ({message['name']}):[/cyan]\n{message['content']}",
                title="Tool Result",
                border_style="bright_blue",
            )
        )

    def display_conversation_updates(self, history, last_shown_index=0):
        """Display new messages in the conversation history"""
        # Ensure we only display new messages
        for i, message in enumerate(history[last_shown_index:], start=last_shown_index):
            if message["role"] == "assistant":
                if "tool_call" in message:
                    self.show_tool_call(
                        message["tool_call"], 
                        message.get("thought", "")
                    )
                elif message.get("content"):
                    self.show_assistant_message(message)
            elif message["role"] == "tool":
                self.show_tool_result(message)
            # Skip user messages as they're already displayed in the input
        
        # Return the new index for tracking what's been shown
        return len(history)

    async def run_repl(self):
        """Run the REPL loop"""
        self.display_welcome()

        # Set up key bindings for multi-line input
        kb = KeyBindings()

        @kb.add("enter")
        def _(event):
            """Submit on Enter key."""
            event.current_buffer.validate_and_handle()

        @kb.add("escape", "enter")
        def _(event):
            """Insert new line on Escape+Enter."""
            event.current_buffer.insert_text("\n")

        # Create prompt session
        session = PromptSession(key_bindings=kb, multiline=True)
        last_shown_index = 0
        
        while True:
            try:
                # Get user input
                self.console.print(
                    "\n[bold blue]>>[/bold blue] (Press Enter to submit, Escape+Enter for new line, 'end' to exit)"
                )
                query = await session.prompt_async("")

                if query.lower() in ("exit", "quit", "end"):
                    self.console.print("[yellow]Goodbye![/yellow]")
                    break
                
                # Show thinking animation
                with Live(refresh_per_second=10, transient=True) as live:
                    frame = 0
                    start_time = time.time()

                    # Run a brief animation
                    while time.time() - start_time < 2.0:
                        frame += 1
                        live.update(self._create_thinking_animation(frame))
                        await asyncio.sleep(0.05)

                # If we're starting a new session, reset the display index
                if not self.current_session_id:
                    last_shown_index = 0

                # Process the query
                is_continuation = False

                # Process the query and get result
                user_query_obj = UserQuery(
                    text=query, 
                    session_id=self.current_session_id,
                    is_continuation_response=is_continuation
                )
                result = await self.orchestrator.process_query(user_query_obj)
                
                # Save the session ID for future queries
                if result and "session_id" in result:
                    self.current_session_id = result["session_id"]

                # Display the conversation updates
                if result.get("conversation_history"):
                    last_shown_index = self.display_conversation_updates(
                        result["conversation_history"], 
                        last_shown_index
                    )

                # Check if we need to ask for continuation
                while (
                    "waiting_for_continuation" in result
                    and result["waiting_for_continuation"]
                ):
                    # Get user's continuation decision
                    self.console.print(
                        "\n[bold yellow]>>[/bold yellow] (continue/stop)"
                    )
                    continuation_choice = await session.prompt_async("")

                    # Process the continuation response
                    user_query_obj = UserQuery(
                        text=continuation_choice,
                        session_id=self.current_session_id,
                        is_continuation_response=True,
                    )

                    # Process the continuation response
                    result = await self.orchestrator.process_query(
                        user_query_obj
                    )

                    # Display any new messages in the conversation
                    if result.get("conversation_history"):
                        last_shown_index = self.display_conversation_updates(
                            result["conversation_history"], 
                            last_shown_index
                        )

                # If the task is completed, show a message and reset session
                if result.get("completed", False):
                    self.console.print("[bold green]Session completed! Starting a new session for your next query.[/bold green]")
                    # Reset session ID if the session is completed
                    self.current_session_id = None
                    last_shown_index = 0

            except KeyboardInterrupt:
                self.console.print(
                    "\n[yellow]Operation cancelled by user[/yellow]"
                )
                self.current_session_id = None
                last_shown_index = 0

            except Exception as e:
                self.console.print(f"[bold red]Error:[/bold red] {str(e)}")
                # Optionally keep the session alive despite errors


async def main():
    """Run the Code Generation Assistant CLI"""
    cli = CodeAssistantCLI()
    await cli.run_repl()


if __name__ == "__main__":
    asyncio.run(main())
