# Assistant Sidebar

A VS Code extension that provides a React-based sidebar assistant for querying an agent API.

## Features

- React-based UI for better display of code and markdown content
- Proper syntax highlighting for code blocks using Prism
- Markdown rendering for rich text responses
- Copy-to-clipboard functionality for code blocks
- Seamless integration with VS Code themes

## Setup and Installation

1. **Install Dependencies**

```bash
cd assistant-sidebar
npm install
cd webview-ui
npm install
```

2. **Build the Webview UI**

```bash
cd assistant-sidebar
npm run build-webview
```

3. **Build the Extension**

```bash
cd assistant-sidebar
npm run compile
```

4. **Start the Extension in Development Mode**

- Press F5 in VS Code to start debugging the extension

## Development

- **Watch Mode for Webview UI**:
  ```bash
  npm run dev-webview
  ```

- **Watch Mode for Extension**:
  ```bash
  npm run watch
  ```

## Usage

1. Click on the Assistant icon in the activity bar
2. Enter your query in the text area
3. Press "Send" or hit Enter to submit your query
4. View the response with properly formatted markdown and code blocks

## API Connection

The extension connects to a Python agent API running on port 5000. Make sure the agent server is running before using the extension.

To start the agent server:
1. Click on the "Agent Server" status bar item
2. A terminal will open and start the server

## How It Works

This extension uses a multi-component architecture:

1. **VS Code Extension**: Provides the UI and handles communication with the Python agent
2. **Python FastAPI Server**: Acts as a bridge between the VS Code extension and the Anthropic Agent
3. **Anthropic Agent**: Processes queries with access to your codebase through MCP tools

When you send a query, the extension captures your current file context and sends it along with your query to the Python server. The server processes the query using the Anthropic Agent and returns the response, which is then displayed in the sidebar.

## Troubleshooting

### Agent Server Not Starting

If the agent server fails to start:

1. Check that you have all required Python packages installed
2. Verify your Anthropic API key is correctly set in the `.env` file
3. Look for error messages in the terminal where the server is running

### No Response from Agent

If you're not getting responses:

1. Check that the agent server is running (look for the terminal)
2. Verify there are no error messages in the terminal
3. Try restarting the agent server from the status bar

### Extension Not Loading

If the extension doesn't load properly:

1. Check the VS Code Developer Tools (Help > Toggle Developer Tools)
2. Look for any error messages related to the extension
3. Try reinstalling the extension

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgements

- This extension uses the Anthropic API for AI capabilities
- Built with VS Code's Extension API 