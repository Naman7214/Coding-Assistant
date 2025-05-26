import asyncio
import aiohttp
import json
from typing import Dict, Any, Optional

class AgentStreamingClient:
    """Client for consuming the streaming agent API"""
    
    def __init__(self, base_url: str = "http://192.168.17.182:5001"):
        self.base_url = base_url
        
    async def stream_query(self, query: str, target_file_path: Optional[str] = None, 
                          on_event=None):
        """
        Stream a query to the agent and handle events
        
        Args:
            query: The query to send to the agent
            target_file_path: Optional file path context
            on_event: Callback function to handle each event
        """
        payload = {
            "query": query,
            "target_file_path": target_file_path
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/stream",
                json=payload,
                headers={"Accept": "text/event-stream"}
            ) as response:
                
                if response.status != 200:
                    raise Exception(f"HTTP {response.status}: {await response.text()}")
                
                async for line in response.content:
                    line = line.decode('utf-8').strip()
                    
                    if line.startswith('data: '):
                        try:
                            event_data = json.loads(line[6:])  # Remove 'data: ' prefix
                            
                            if on_event:
                                await on_event(event_data)
                            else:
                                # Default handler - just print
                                await self._default_event_handler(event_data)
                                
                        except json.JSONDecodeError as e:
                            print(f"Failed to parse event data: {e}")
                            print(f"Raw line: {line}")

    async def _default_event_handler(self, event: Dict[str, Any]):
        """Default event handler that prints events in a nice format"""
        event_type = event.get('type', 'unknown')
        content = event.get('content', '')
        metadata = event.get('metadata', {})
        timestamp = event.get('timestamp', 0)
        
        # Format timestamp
        import datetime
        time_str = datetime.datetime.fromtimestamp(timestamp).strftime('%H:%M:%S')
        
        if event_type == "thinking":
            print(f"🤔 [{time_str}] Thinking: {content}")
            
        elif event_type == "tool_selection":
            tool_name = metadata.get('tool_name', 'unknown')
            print(f"🔧 [{time_str}] Selected tool: {tool_name}")
            if metadata.get('tool_arguments'):
                print(f"   Arguments: {json.dumps(metadata['tool_arguments'], indent=2)}")
                
        elif event_type == "tool_execution":
            if metadata.get('requires_permission'):
                print(f"⚠️  [{time_str}] {content}")
            else:
                print(f"⚙️  [{time_str}] {content}")
                
        elif event_type == "tool_result":
            tool_name = metadata.get('tool_name', 'unknown')
            result_length = metadata.get('result_length', 0)
            is_error = metadata.get('error', False)
            
            if is_error:
                print(f"❌ [{time_str}] Tool {tool_name} failed:")
                print(f"   {content}")
            else:
                print(f"✅ [{time_str}] Tool {tool_name} result ({result_length} chars):")
                # Truncate long results for display
                display_content = content[:500] + "..." if len(content) > 500 else content
                print(f"   {display_content}")
                
        elif event_type == "assistant_response":
            print(f"🤖 [{time_str}] Assistant: {content}")
            
        elif event_type == "final_response":
            print(f"✨ [{time_str}] Final response received")
            
        elif event_type == "error":
            print(f"💥 [{time_str}] Error: {content}")
            
        else:
            print(f"📝 [{time_str}] {event_type}: {content}")

# Example usage for VSCode extension integration
class VSCodeExtensionHandler:
    """Example handler for VSCode extension integration"""
    
    def __init__(self, vscode_api):
        self.vscode_api = vscode_api  # Your VSCode extension API
        
    async def handle_agent_event(self, event: Dict[str, Any]):
        """Handle streaming events and send to VSCode extension"""
        event_type = event.get('type')
        content = event.get('content')
        metadata = event.get('metadata', {})
        
        if event_type == "thinking":
            # Show thinking indicator in VSCode
            await self.vscode_api.show_progress("🤔 " + content)
            
        elif event_type == "tool_selection":
            tool_name = metadata.get('tool_name')
            # Show tool selection in VSCode
            await self.vscode_api.show_info(f"Using tool: {tool_name}")
            
        elif event_type == "tool_execution":
            if metadata.get('requires_permission'):
                # Request permission from user
                permission = await self.vscode_api.request_permission(content)
                # You'd need to send this back to the agent somehow
                
        elif event_type == "tool_result":
            tool_name = metadata.get('tool_name')
            is_error = metadata.get('error', False)
            
            if is_error:
                await self.vscode_api.show_error(f"Tool {tool_name} failed: {content}")
            else:
                # Show tool result, maybe in a separate panel
                await self.vscode_api.show_tool_result(tool_name, content)
                
        elif event_type == "assistant_response":
            # Stream the assistant's response to the chat panel
            await self.vscode_api.append_to_chat(content, "assistant")
            
        elif event_type == "final_response":
            # Mark the response as complete
            await self.vscode_api.mark_response_complete()
            
        elif event_type == "error":
            await self.vscode_api.show_error(content)

# Example usage
async def main():
    """Example of how to use the streaming client"""
    client = AgentStreamingClient()
    
    # Example 1: Simple usage with default handler
    print("=== Example 1: Simple streaming ===")
    await client.stream_query("List the files in the current directory")
    
    print("\n=== Example 2: Custom event handler ===")
    
    # Example 2: Custom event handler
    async def custom_handler(event):
        event_type = event.get('type')
        content = event.get('content')
        
        if event_type == "tool_selection":
            print(f"🎯 Agent chose: {event.get('metadata', {}).get('tool_name')}")
        elif event_type == "assistant_response":
            print(f"💬 Response: {content}")
        # Handle other events as needed
    
    await client.stream_query(
        "Create a simple Python function that adds two numbers",
        target_file_path="example.py",
        on_event=custom_handler
    )

if __name__ == "__main__":
    asyncio.run(main()) 