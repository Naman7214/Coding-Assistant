"""
Controller component for the MCP architecture.
Handles business logic and coordinates between the model and presenter.
"""
from typing import Dict, Any, Optional
import os
import sys

# Add the parent directory to sys.path to import the agent module
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agent.agent import Agent

class Controller:
    """Controller for the Code Generation Assistant"""
    
    def __init__(self, api_key: Optional[str] = None):
        """Initialize the controller
        
        Args:
            api_key: OpenAI API key (optional)
        """
        self.agent = Agent(api_key=api_key)
    
    def process_query(self, query: str) -> Dict[str, Any]:
        """Process a query from the user
        
        Args:
            query: User query
            
        Returns:
            Response data to be presented
        """
        # Get the agent's response
        response = self.agent.process_query(query)
        
        # Convert to a dictionary for the presenter
        return {
            "message": response.message,
            "tool_calls": [tool_call for tool_call in response.tool_calls],
            "tool_results": response.tool_results
        }
    
    def reset(self):
        """Reset the agent's state"""
        self.agent.reset()