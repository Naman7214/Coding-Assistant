# Agent Component

This component implements an AI agent that can orchestrate a workflow of tool calls to fulfill user requests.

## Architecture

The agent follows a single-agent architecture where:

1. The agent receives a user query
2. It determines which tool to call and with what parameters
3. The tool is executed via the MCP server
4. The results are fed back to the agent to determine the next step
5. This process repeats until the task is completed or a maximum of 25 tool calls is reached
6. If the maximum is reached, the user is asked if they want to continue

## Components

- **Orchestrator**: Manages the overall workflow and tool execution sequence
- **LLM Adapter**: Interfaces with Claude 3.7 Sonnet for decision making
- **Tool Adapter**: Interfaces with the MCP server to execute tools
- **Models**: Pydantic schemas for data validation and transfer
- **Config**: Configuration settings and environment variables

## Usage

1. Set up environment variables (see `.env.example`)
2. Install dependencies: `pip install -r requirements.txt`
3. Run the server: `python -m agent.main`

The agent exposes two main API endpoints:
- POST `/api/agent/process`: Process a user query
- POST `/api/agent/continue`: Continue processing after reaching the maximum tool calls

## Example

```python
import requests

# Process a user query
response = requests.post(
    "http://localhost:8001/api/agent/process",
    json={
        "text": "Find all Python files in the project and count the lines of code",
        "session_id": "session-123"
    }
)

# If the agent asks for continuation
if response.json().get("requires_user_input"):
    continuation = requests.post(
        "http://localhost:8001/api/agent/continue",
        json={
            "session_id": "session-123",
            "continue_processing": True
        }
    ) 