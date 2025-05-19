# Code Generation Assistant

The Code Generation Assistant is a powerful AI agent system designed to help with coding tasks. It consists of three main components: the Backend, the MCP Server, and the AI Coding Agent, which work together to provide a comprehensive code assistance experience.

## System Architecture

- **AI Coding Agent**: An agent powered by Claude 3.7 Sonnet that can understand coding problems and use tools to solve them.
- **MCP Server**: A middleware server that acts as a bridge between the AI agent and the backend. It provides a list of tools the AI agent can use.
- **Backend**: A FastAPI application that implements the logic for the tools used by the AI agent through the MCP server.

## Prerequisites

- Python 3.8+
- pip
- install ripgrep , for Mac : ```brew install ripgrep```
- install fzf , for Mac : ```brew install fzf```


## Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   cd Code-Generation-Assistant
   ```

2. Install requirements:
   ```
   pip install -r requirements.txt
   ```

3. Create environment variables:
   - Create `.env` in the root directory following `.env.example`
   - Create `.env` in the `/system/coding_agent` directory following `.env.example`

## Common Issues & Solutions

### ImportError: cannot import name 'SON' from 'bson'

If you encounter this error while installing dependencies:
```
ImportError: cannot import name 'SON' from 'bson' (/Users/jaypanchal/.pyenv/versions/3.10.2/lib/python3.10/site-packages/bson/__init__.py)
```

Run the following commands to fix it:
```
pip uninstall bson
pip install --force-reinstall pymongo
```

### Crawl4AI Error

If you encounter errors related to crawl4ai:
```
pip uninstall crawl4ai
pip install Crawl4AI
```

## Running the Application

### 1. Start the Backend

From the root directory(/Code-Generation-Assistant):
```
uvicorn system.backend.main:app
```

### 2. Start the MCP Server

From the root directory(/Code-Generation-Assistant):
```
python -m system.mcp_server.server
```

### 3. Start the AI Coding Agent

Navigate to the coding agent directory and run:
```
cd system/coding_agent
python agent_with_cli.py
```

## Components

### Backend

The backend is a FastAPI application that implements various tools for file access, code modification, terminal commands, web search, and more.

### MCP Server

The MCP server provides a standardized interface for the AI agent to interact with the backend tools. It handles tool registration, validation, and execution.

### AI Coding Agent

The AI coding agent uses Claude 3.7 Sonnet to understand user queries and interact with the MCP server to execute appropriate tools based on the requirements.
