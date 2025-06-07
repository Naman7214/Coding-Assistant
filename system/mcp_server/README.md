# MCP Server

This directory contains the MCP (Model Context Protocol) server implementation for the Code Generation Assistant.

## Server Implementations

There are two server implementations available:

1. **server.py**: The original implementation using the `mcp.server.lowlevel` library.
2. **fastmcp_server.py**: A new implementation using the `fastmcp` library.

## Using the FastMCP Server

The FastMCP server provides a more Pythonic interface for creating MCP servers while maintaining the same functionality as the original implementation.

### Running the Server

```bash
# Navigate to the project root
cd /path/to/Code-Generation-Assistant

# Run the FastMCP server
python -m system.mcp_server.fastmcp_server --port 8001
```

### Testing the Server

You can use the provided test script to verify that the server is running correctly:

```bash
python test_fastmcp_server.py
```

### Available Tools

The FastMCP server provides the following tools:

- **grep_search**: Find exact text matches or regex patterns
- **read_file_tool**: Read the contents of a file
- **run_terminal_cmd**: Run terminal commands
- **delete_file_tool**: Delete files with safety checks
- **list_dir**: List directory contents
- **search_replace**: Search and replace text in files
- **search_files_tool**: Fuzzy search for files
- **web_search_tool**: Search the web for information
- **codebase_search_tool**: Semantic search in the codebase
- **edit_file_tool**: Edit files with proposed changes
- **reapply_tool**: Reapply failed edits with a smarter model

### Implementation Details

The FastMCP server uses the `@mcp.tool()` decorator to define tools, which simplifies the code compared to the original implementation. Each tool is defined as an async function with type hints that FastMCP uses to generate the tool schema.

The server runs using the SSE (Server-Sent Events) transport on the specified port, making it compatible with MCP clients that support this transport.

## Switching Between Implementations

You can switch between the original and FastMCP implementations by updating your client code to point to the appropriate server endpoint. 