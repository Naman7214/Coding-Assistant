"""
Presenter component for the MCP architecture.
Handles presenting data to the user through the UI layer.
"""
from typing import Dict, Any, Callable

class Presenter:
    """Presenter for the Code Generation Assistant"""
    
    def __init__(self, render_callback: Callable[[Dict[str, Any]], None]):
        """Initialize the presenter with a render callback
        
        Args:
            render_callback: Function to call to render output to the UI
        """
        self.render_callback = render_callback
    
    def present(self, data: Dict[str, Any]):
        """Present data to the user
        
        Args:
            data: Data to present
        """
        # Process the data if needed before rendering
        self.render_callback(data)
    
    def format_tool_result(self, tool: str, result: Dict[str, Any]) -> str:
        """Format a tool result for display
        
        Args:
            tool: Name of the tool
            result: Result of the tool execution
            
        Returns:
            Formatted string representation of the result
        """
        # Simple formatter for CLI display
        if "error" in result:
            return f"Error executing {tool}: {result['error']}"
            
        if tool == "list_dir":
            files = result.get("files", [])
            dirs = result.get("directories", [])
            return f"Found {len(files)} files and {len(dirs)} directories"
            
        elif tool == "read_file":
            return f"Read {result.get('read_lines', 0)} lines from {result.get('file', 'unknown')}"
            
        elif tool == "codebase_search":
            matches = result.get("matches", [])
            return f"Found {len(matches)} matches for query '{result.get('query', '')}'"
            
        # Add more formatters as needed
        
        return str(result)