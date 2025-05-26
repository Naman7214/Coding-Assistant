# Agent Streaming API

This directory contains the streaming implementation of the coding agent that provides real-time updates to VSCode extensions and other clients.

## Files Overview

- **`agent_streaming_api.py`** - FastAPI server that streams agent responses
- **`streaming_client_example.py`** - Python client example for consuming the streaming API
- **`vscode_streaming_client.ts`** - TypeScript client for VSCode extensions
- **`STREAMING_README.md`** - This documentation file

## Features

### Real-time Streaming Events

The streaming API provides the following event types:

1. **`thinking`** - Agent's reasoning process
2. **`tool_selection`** - When agent chooses a tool to use
3. **`tool_execution`** - Tool execution status and permission requests
4. **`tool_result`** - Results from tool execution
5. **`assistant_response`** - Agent's text responses
6. **`final_response`** - Marks completion of the response
7. **`error`** - Error messages

### Event Structure

Each event follows this structure:

```json
{
    "type": "tool_selection",
    "content": "Selected tool: read_file",
    "metadata": {
        "tool_name": "read_file",
        "tool_arguments": {"file_path": "example.py"},
        "tool_use_id": "toolu_123"
    },
    "timestamp": 1703123456.789
}
```

## Usage

### 1. Start the Streaming API Server

```bash
cd system/coding_agent
python agent_streaming_api.py
```

The server will start on `http://192.168.17.182:5001`

### 2. Python Client Example

```python
from streaming_client_example import AgentStreamingClient

client = AgentStreamingClient()

# Simple usage
await client.stream_query("List files in current directory")

# With custom event handler
async def my_handler(event):
    print(f"Event: {event['type']} - {event['content']}")

await client.stream_query(
    "Create a Python function",
    target_file_path="example.py",
    on_event=my_handler
)
```

### 3. VSCode Extension Integration

```typescript
import { VSCodeAgentIntegration, createAgentIntegration } from './vscode_streaming_client';

// In your VSCode extension
const integration = createAgentIntegration(context);

// Handle user query
await integration.processQuery(
    "Explain this function",
    vscode.window.activeTextEditor?.document.fileName
);
```

## API Endpoints

### POST `/stream`

Streams agent responses in real-time.

**Request:**
```json
{
    "query": "Your question or request",
    "target_file_path": "/path/to/file" // optional
}
```

**Response:** Server-Sent Events stream with `data:` prefixed JSON events.

### POST `/health`

Health check endpoint.

**Response:**
```json
{
    "status": "healthy" | "unhealthy"
}
```

## VSCode Extension Integration Guide

### 1. Install Dependencies

```bash
npm install node-fetch
# or for newer Node.js versions, use built-in fetch
```

### 2. Create Agent Service

```typescript
// src/agentService.ts
import { VSCodeAgentIntegration } from './vscode_streaming_client';

export class AgentService {
    private integration: VSCodeAgentIntegration;

    constructor(context: vscode.ExtensionContext) {
        const outputChannel = vscode.window.createOutputChannel('Agent');
        const statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left
        );
        
        this.integration = new VSCodeAgentIntegration(
            outputChannel,
            statusBarItem
        );
    }

    async askAgent(query: string): Promise<void> {
        const activeFile = vscode.window.activeTextEditor?.document.fileName;
        await this.integration.processQuery(query, activeFile);
    }
}
```

### 3. Register Commands

```typescript
// src/extension.ts
import { AgentService } from './agentService';

export function activate(context: vscode.ExtensionContext) {
    const agentService = new AgentService(context);

    // Register command
    const disposable = vscode.commands.registerCommand(
        'extension.askAgent',
        async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'What would you like to ask the agent?'
            });
            
            if (query) {
                await agentService.askAgent(query);
            }
        }
    );

    context.subscriptions.push(disposable);
}
```

### 4. Package.json Configuration

```json
{
    "contributes": {
        "commands": [
            {
                "command": "extension.askAgent",
                "title": "Ask Agent"
            }
        ],
        "keybindings": [
            {
                "command": "extension.askAgent",
                "key": "ctrl+shift+a",
                "mac": "cmd+shift+a"
            }
        ]
    }
}
```

## Event Handling Examples

### Progress Indication

```typescript
private async handleEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
        case 'thinking':
            // Show progress indicator
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Agent is thinking...",
                cancellable: false
            }, () => {
                return new Promise(resolve => {
                    // Resolve when thinking is done
                });
            });
            break;
    }
}
```

### Tool Permission Requests

```typescript
case 'tool_execution':
    if (event.metadata?.requires_permission) {
        const choice = await vscode.window.showWarningMessage(
            event.content,
            { modal: true },
            'Allow',
            'Deny'
        );
        
        if (choice !== 'Allow') {
            // Handle permission denial
            return;
        }
    }
    break;
```

### File Edit Notifications

```typescript
case 'tool_result':
    if (event.metadata?.tool_name === 'edit_file') {
        const targetFile = event.metadata?.target_file;
        if (targetFile) {
            // Refresh file in editor
            const doc = await vscode.workspace.openTextDocument(targetFile);
            await vscode.window.showTextDocument(doc);
            
            // Show notification
            vscode.window.showInformationMessage(
                `File updated: ${path.basename(targetFile)}`
            );
        }
    }
    break;
```

## Configuration

### Environment Variables

- `MCP_SERVER_URL` - MCP server URL (default: `http://localhost:8001/sse`)
- `MCP_TRANSPORT_TYPE` - Transport type (default: `sse`)

### Server Configuration

The streaming API runs on port 5001 by default. You can change this in `agent_streaming_api.py`:

```python
if __name__ == "__main__":
    uvicorn.run(app, host="192.168.17.182", port=5001)
```

## Differences from Original API

| Feature | Original API | Streaming API |
|---------|-------------|---------------|
| Response Type | Single JSON response | Server-Sent Events stream |
| Real-time Updates | No | Yes |
| Tool Visibility | Only final results | Step-by-step progress |
| Permission Handling | Blocking prompts | Event-based requests |
| Error Handling | Single error response | Granular error events |

## Troubleshooting

### Connection Issues

1. Ensure the streaming API server is running
2. Check firewall settings for port 5001
3. Verify the base URL in your client

### Event Parsing Errors

1. Check that events are properly formatted JSON
2. Ensure the `data:` prefix is handled correctly
3. Verify UTF-8 encoding

### VSCode Extension Issues

1. Check the Output Channel for detailed logs
2. Ensure proper error handling in event handlers
3. Verify that async operations are properly awaited

## Performance Considerations

- Events are streamed in real-time, so handle them efficiently
- Large tool results are automatically truncated
- Consider debouncing UI updates for rapid events
- Use appropriate logging levels to avoid spam

## Security Notes

- The streaming API runs on a local network interface
- No authentication is implemented (suitable for local development)
- Tool permission requests should be handled carefully
- Consider rate limiting for production use 