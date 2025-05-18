"""
CLI interface for the Code Generation Assistant.
This module provides a minimalist command-line interface using Rich for enhanced output.
"""
import os
import asyncio
import sys
from typing import Dict, Any
import time
from rich.console import Console
from rich.panel import Panel
from rich.live import Live
from rich.text import Text
from rich.align import Align
from rich.box import ROUNDED
from prompt_toolkit import PromptSession
from prompt_toolkit.key_binding import KeyBindings

# Add the necessary path to import agent modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agent.core.orchestrator import Orchestrator  # Adjust this import based on your actual agent implementation
from agent.adapters.llm_adapter import LLMAdapter
from agent.adapters.tool_adapter import ToolAdapter
from agent.models.schemas import UserQuery

class CodeAssistantCLI:
    """Minimalist CLI for the Code Generation Assistant"""
    
    def __init__(self):
        """Initialize the CLI interface"""
        self.llm_adapter = LLMAdapter()
        self.tool_adapter = ToolAdapter()
        self.orchestrator = Orchestrator(self.llm_adapter, self.tool_adapter)
        self.console = Console()
    
    def display_welcome(self):
        """Display a welcome message"""
        self.console.print(Panel.fit(
            "[bold blue]Code Generation Assistant[/bold blue]\n"
            "Type your instructions or 'exit' to quit.",
            border_style="blue"
        ))
    
    def _create_thinking_animation(self, frame: int) -> Panel:
        """Create animated thinking dots"""
        text = Text("Thinking")
        dots = ["⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂", "⠁"]
        
        for i in range(3):
            dot = dots[(frame + i*2) % len(dots)]
            text.append(f" {dot}", style="bold cyan")
            
        return Panel(
            Align.left(text),
            box=ROUNDED,
            border_style="bright_blue",
            title="Processing",
            width=30,
            padding=(0, 1)
        )
    
    def show_thinking(self, reasoning: Dict[str, Any]):
        """Display the agent's reasoning process"""
        if "thinking" in reasoning:
            self.console.print(Panel(
                reasoning["thinking"],
                title="Agent Reasoning",
                border_style="yellow"
            ))
        
        if "tool_calls" in reasoning:
            for tool in reasoning["tool_calls"]:
                self.console.print(Panel(
                    f"[cyan]Tool:[/cyan] {tool['name']}\n"
                    f"[magenta]Parameters:[/magenta] {tool['parameters']}",
                    title="Tool Call",
                    border_style="blue"
                ))
    
    def show_result(self, result: Dict[str, Any]):
        """Display the final result"""
        if "conversation_history" in result:
            # Get the last assistant message
            for message in reversed(result["conversation_history"]):
                if message["role"] == "assistant" and "content" in message and message["content"]:
                    self.console.print(Panel(
                        message["content"],
                        title="Result",
                        border_style="green"
                    ))
                    break
    
    async def run_repl(self):
        """Run the REPL loop"""
        self.display_welcome()
        
        # Set up key bindings for multi-line input
        kb = KeyBindings()
        
        @kb.add('enter')
        def _(event):
            """Submit on Enter key."""
            event.current_buffer.validate_and_handle()
        
        @kb.add('escape', 'enter')
        def _(event):
            """Insert new line on Escape+Enter."""
            event.current_buffer.insert_text('\n')
        
        # Create prompt session
        session = PromptSession(key_bindings=kb, multiline=True)
        
        while True:
            try:
                # Get user input
                self.console.print("\n[bold blue]>>[/bold blue] (Press Enter to submit, Escape+Enter for new line)")
                query = await session.prompt_async("")
                
                if query.lower() in ('exit', 'quit'):
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
                
                # Process the query and get reasoning steps and result
                user_query_obj = UserQuery(text=query)
                reasoning_steps, result = await self.orchestrator.process_query(user_query_obj)
                
                # Display the reasoning steps
                self.show_thinking(reasoning_steps)
                
                # Display the final result
                self.show_result(result)
                
            except KeyboardInterrupt:
                self.console.print("\n[yellow]Operation cancelled by user[/yellow]")
                
            except Exception as e:
                self.console.print(f"[bold red]Error:[/bold red] {str(e)}")


async def main():
    """Run the Code Generation Assistant CLI"""
    cli = CodeAssistantCLI()
    await cli.run_repl()


if __name__ == "__main__":
    asyncio.run(main())