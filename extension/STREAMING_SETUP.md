# VSCode Extension Streaming Setup

This guide explains how to set up and use the streaming functionality in your VSCode extension.

## Files Created

### Backend (TypeScript)
- `src/streaming_client.ts` - Streaming client that handles Server-Sent Events
- `src/extension_streaming.ts` - Enhanced extension with streaming support

### Frontend (React)
- `webview-ui/src/AppStreaming.tsx` - React component with streaming UI
- `webview-ui/src/AppStreaming.css` - Styles for streaming interface

## Setup Instructions

### 1. Update Your Extension Entry Point

You have two options:

**Option A: Replace existing extension.ts**
```bash
cd assistant-sidebar/src
mv extension.ts extension_original.ts
mv extension_streaming.ts extension.ts
```

**Option B: Use both (recommended for testing)**
Keep both files and switch between them by updating `package.json`:
```json
{
  "main": "./out/extension_streaming.js"
}
```

### 2. Update the React App

**Option A: Replace existing App.tsx**
```bash
cd assistant-sidebar/webview-ui/src
mv App.tsx App_original.tsx
mv AppStreaming.tsx App.tsx
```

**Option B: Import the streaming app**
Update `webview-ui/src/index.tsx`:
```tsx
import AppStreaming from './AppStreaming';
// Use AppStreaming instead of App
```

### 3. Build the Extension

```bash
cd assistant-sidebar
npm run compile
npm run build-webview
```

### 4. Start the Streaming Server

Make sure your streaming agent server is running:
```bash
cd system/coding_agent
python3 agent_streaming_api.py
```

## Features

### Real-time Streaming
- **Thinking Process**: See the agent's reasoning in real-time
- **Tool Selection**: Watch which tools the agent chooses
- **Tool Execution**: Monitor tool execution progress
- **Results**: View tool results as they complete
- **Responses**: Stream assistant responses incrementally

### UI Components

#### Header Controls
- **Streaming Toggle**: Switch between streaming and original API
- **Health Indicator**: Shows streaming server status (🟢/🔴)

#### Status Bar
- Shows current thinking process
- Displays active tool execution

#### Stream Events Panel
- Collapsible panel showing all streaming events
- Color-coded by event type
- Timestamps and metadata for each event

#### Response Area
- Real-time response streaming
- Auto-scroll to latest content
- Markdown rendering support

### Commands Available

1. **Ask Agent** (`Ctrl+Shift+P` → "Ask Agent")
   - Quick input dialog for queries
   - Uses streaming by default

2. **Start Streaming Server**
   - Launches the streaming agent server in terminal

3. **Refresh Connection**
   - Checks streaming server health
   - Updates status indicators

4. **Show Output**
   - Opens the agent output channel for debugging

## Configuration

### Server URLs
Update these in `src/extension_streaming.ts`:
```typescript
const AGENT_API_URL = 'http://192.168.17.182:5000';      // Original API
const STREAMING_API_URL = 'http://192.168.17.182:5001';  // Streaming API
```

### Streaming Client
Update in `src/streaming_client.ts`:
```typescript
constructor(
    baseUrl: string = "http://192.168.17.182:5001",  // Your streaming server
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem
)
```

## Usage

### Basic Query
1. Open the Assistant sidebar
2. Type your query in the text area
3. Click "Send" or press Enter
4. Watch the real-time streaming progress

### Toggle Streaming
- Click the 🔄/📝 button to switch between streaming and original API
- Streaming shows real-time progress
- Original API shows only final results

### Monitor Progress
- Status bar shows current thinking/tool execution
- Stream events panel shows detailed event log
- Output channel shows technical logs

### Permission Requests
When tools require permission (like `run_terminal_command`):
1. A modal dialog will appear
2. Choose "Allow" or "Deny"
3. The agent continues based on your choice

## Troubleshooting

### Streaming Server Not Available
- Check if the streaming server is running on port 5001
- Verify the server URL in configuration
- Click the health indicator (🔴) to refresh status

### No Streaming Events
- Ensure you're using the streaming API (🔄 button enabled)
- Check the output channel for error messages
- Verify network connectivity to the streaming server

### WebView Not Loading
- Run `npm run build-webview` to rebuild the React app
- Check browser console in VSCode Developer Tools
- Ensure all dependencies are installed

### Extension Errors
- Check VSCode Developer Console (`Help` → `Toggle Developer Tools`)
- Review the output channel for detailed logs
- Ensure TypeScript compilation succeeded

## Development

### Adding New Event Types
1. Update the `StreamEvent` interface in `AppStreaming.tsx`
2. Add handling in `handleStreamEvent` method
3. Add CSS styling for the new event type

### Customizing UI
- Modify `AppStreaming.css` for styling changes
- Update `AppStreaming.tsx` for component changes
- Rebuild with `npm run build-webview`

### Backend Changes
- Modify `streaming_client.ts` for client behavior
- Update `extension_streaming.ts` for VSCode integration
- Recompile with `npm run compile`

## API Compatibility

The streaming extension maintains compatibility with your original API:
- Falls back to original API when streaming is disabled
- Supports all existing query parameters
- Maintains the same response format for non-streaming requests 