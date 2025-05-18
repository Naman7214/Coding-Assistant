"""
CLI interface for the Code Generation Assistant.
This module provides a command-line interface using Rich for enhanced output.
"""
import os
import sys
import json
import time
import math
from typing import Optional, List, Dict, Any, Callable
import typer
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.markdown import Markdown
from rich.table import Table
from rich.prompt import Prompt
from rich.live import Live
from rich.text import Text
from rich.align import Align
from rich.box import ROUNDED
from prompt_toolkit import PromptSession
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.keys import Keys

# Add the parent directory to sys.path to import the agent module
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp.presenter import Presenter
from mcp.controller import Controller

app = typer.Typer()
console = Console()

class RichCLI:
    """Rich CLI interface for the Code Generation Assistant"""
    
    def __init__(self, api_key: Optional[str] = None):
        """Initialize the CLI interface"""
        # Initialize the MCP components
        self.controller = Controller(api_key=api_key)
        self.presenter = Presenter(self._render_output)
        self.console = Console()
    
    def display_welcome(self):
        """Display a welcome message"""
        self.console.print(Panel.fit(
            "[bold blue]Code Generation Assistant[/bold blue]\n"
            "Type your instructions or 'exit' to quit.",
            border_style="blue"
        ))
    
    def _create_thinking_animation(self, frame: int) -> Panel:
        """Create animated thinking dots like in Codex CLI"""
        text = Text("Thinking")
        
        # Create array of dot characters with different sizes
        braille_dots = ["⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂", "⠁", "⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"]
        
        # Calculate the positions of each dot based on frame
        dot_frames = [
            braille_dots[(frame) % len(braille_dots)],
            braille_dots[(frame + 2) % len(braille_dots)],
            braille_dots[(frame + 4) % len(braille_dots)]
        ]
        
        # Add the dots with cyan color
        for i, dot in enumerate(dot_frames):
            style = "bold cyan"
            text.append(f" {dot}", style=style)
            
        # Wrap the animation in a panel
        return Panel(
            Align.left(text),
            box=ROUNDED,
            border_style="bright_blue",
            title="Processing",
            width=30,
            padding=(0, 1)
        )
    
    def _render_output(self, output: Dict[str, Any]):
        """Render the output using Rich formatting"""
        # Display the main message
        if "message" in output:
            self.console.print(Panel(output["message"], border_style="green", title="Response"))
        
        # Display tool calls if any
        if "tool_calls" in output and output["tool_calls"]:
            table = Table(title="Tool Calls")
            table.add_column("Tool", style="cyan")
            table.add_column("Parameters", style="magenta")
            
            for tool_call in output["tool_calls"]:
                table.add_row(
                    tool_call["tool"],
                    str(tool_call["parameters"])
                )
            
            self.console.print(table)
        
        # Display detailed tool results
        if "tool_results" in output:
            for result in output["tool_results"]:
                tool = result["tool"]
                
                if "error" in result:
                    self.console.print(f"[bold red]Error calling {tool}:[/bold red] {result['error']}")
                    continue
                
                tool_result = result["result"]
                
                if tool == "read_file" and "content" in tool_result:
                    language = self._guess_language_from_file(result["parameters"]["target_file"])
                    syntax = Syntax(
                        tool_result["content"],
                        language,
                        theme="monokai",
                        line_numbers=True,
                        word_wrap=True
                    )
                    self.console.print(Panel(
                        syntax,
                        title=f"File: {result['parameters']['target_file']}",
                        border_style="blue"
                    ))
                    
                elif tool == "list_dir":
                    if "error" in tool_result:
                        self.console.print(f"[bold red]Error:[/bold red] {tool_result['error']}")
                    else:
                        dir_table = Table(title=f"Directory: {tool_result['path']}")
                        dir_table.add_column("Name", style="cyan")
                        dir_table.add_column("Type", style="magenta")
                        
                        for dir_name in sorted(tool_result["directories"]):
                            dir_table.add_row(dir_name, "Directory")
                        
                        for file_name in sorted(tool_result["files"]):
                            dir_table.add_row(file_name, "File")
                        
                        self.console.print(dir_table)
                        
                elif tool == "codebase_search":
                    if tool_result.get("matches"):
                        matches_table = Table(title=f"Search results for: {tool_result['query']}")
                        matches_table.add_column("File", style="cyan")
                        matches_table.add_column("Content", style="green")
                        
                        for match in tool_result["matches"]:
                            matches_table.add_row(match["file"], match["content"][:100] + "...")
                        
                        self.console.print(matches_table)
                    else:
                        self.console.print("[yellow]No matches found[/yellow]")
                        
                elif tool == "run_terminal_cmd":
                    self.console.print(Panel(
                        f"Command: [bold]{result['parameters']['command']}[/bold]\n\n"
                        f"[green]STDOUT:[/green]\n{tool_result.get('stdout', '')}\n\n"
                        f"[red]STDERR:[/red]\n{tool_result.get('stderr', '')}",
                        title=f"Command Result (Exit code: {tool_result.get('return_code', 'N/A')})",
                        border_style="yellow"
                    ))
    
    def _guess_language_from_file(self, filename: str) -> str:
        """Guess the language based on file extension"""
        ext = filename.split('.')[-1].lower() if '.' in filename else ''
        
        lang_map = {
            'py': 'python',
            'js': 'javascript',
            'ts': 'typescript',
            'html': 'html',
            'css': 'css',
            'json': 'json',
            'md': 'markdown',
            'sh': 'bash',
            'bash': 'bash',
            'txt': 'text',
            'yml': 'yaml',
            'yaml': 'yaml',
        }
        
        return lang_map.get(ext, 'text')
    
    def run_repl(self):
        """Run the REPL loop"""
        self.display_welcome()
        
        # Set up key bindings for multi-line input
        kb = KeyBindings()
        
        @kb.add('enter')
        def _(event):
            """Submit on Enter key."""
            event.current_buffer.validate_and_handle()
        
        @kb.add('escape', 'enter')  # Use escape followed by enter for new line
        def _(event):
            """Insert new line on Escape+Enter."""
            event.current_buffer.insert_text('\n')
        
        # Create prompt session with key bindings
        session = PromptSession(key_bindings=kb, multiline=True)
        
        while True:
            try:
                # Get input with support for multi-line (Escape+Enter for new line)
                self.console.print("\n[bold blue]>>[/bold blue] (Press Enter to submit, Escape+Enter for new line)")
                query = session.prompt("")
                
                if query.lower() in ('exit', 'quit'):
                    self.console.print("[yellow]Goodbye![/yellow]")
                    break
                
                # If input has multiple lines, show a preview
                if '\n' in query:
                    language = self._detect_language(query)
                    self.console.print("Input:")
                    self.console.print(Syntax(
                        query,
                        language,
                        theme="monokai",
                        line_numbers=True
                    ))
                
                # Use a separate Live context with a fixed 5-second display time
                with Live(refresh_per_second=10, transient=True) as live:
                    frame = 0
                    start_time = time.time()
                    
                    # Run the animation for exactly 5 seconds
                    while time.time() - start_time < 5.0:
                        frame += 1
                        live.update(self._create_thinking_animation(frame))
                        time.sleep(0.05)
                
                # Get the actual response (hardcoded for now)
                response = self.controller.process_query(query)
                
                # Present the response
                self.presenter.present(response)
                
            except KeyboardInterrupt:
                self.console.print("\n[yellow]Operation cancelled by user[/yellow]")
                
            except Exception as e:
                self.console.print(f"[bold red]Error:[/bold red] {str(e)}")

    def _detect_language(self, text: str) -> str:
        """Detect the programming language from the input text"""
        if any(keyword in text.lower() for keyword in ["def ", "class ", "import ", "from ", "#"]):
            return "python"
        elif any(keyword in text.lower() for keyword in ["function", "var ", "const ", "let ", "//"]):
            return "javascript"
        elif any(keyword in text.lower() for keyword in ["<html", "<div", "<body", "<script"]):
            return "html"
        else:
            return "text"


@app.command()
def main(api_key: Optional[str] = typer.Option(None, help="OpenAI API key")):
    """Run the Code Generation Assistant CLI"""
    cli = RichCLI(api_key=api_key)
    cli.run_repl()


if __name__ == "__main__":
    app()