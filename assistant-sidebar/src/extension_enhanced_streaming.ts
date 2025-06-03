import axios from 'axios';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { EnhancedStreamingClient } from './enhanced_streaming_client';
import { getWebviewContent } from './utilities';

const AGENT_API_PORT = 5000; // Port for the Python agent API (original)
const STREAMING_API_PORT = 5001; // Port for the TRUE streaming API
const AGENT_API_URL = 'http://0.0.0.0:5000';
const STREAMING_API_URL = 'http://0.0.0.0:5001'; //192.168.17.182

class EnhancedAssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'enhancedAssistantView';
  private _view?: vscode.WebviewView;
  private agentServer?: http.Server;
  private isAgentRunning = false;
  private enhancedStreamingClient?: EnhancedStreamingClient;
  private outputChannel: vscode.OutputChannel;
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem
  ) {
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getEnhancedWebviewContent(webviewView.webview);

    // Initialize enhanced streaming client
    this.enhancedStreamingClient = new EnhancedStreamingClient(
      STREAMING_API_URL,
      this.outputChannel,
      this.statusBarItem
    );

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      async message => {
        await this.handleMessage(message);
      }
    );

    // Check streaming server health on startup
    this.checkEnhancedStreamingHealth();
  }

  private async handleMessage(message: any) {
    switch (message.command) {
      case 'sendQuery':
        await this.handleEnhancedQuery(message.text, message.useStreaming);
        return;

      case 'checkStreamingHealth':
        await this.checkEnhancedStreamingHealth();
        return;

      case 'permissionResponse':
        await this.handlePermissionResponse(message.permissionId, message.granted);
        return;

      case 'clearState':
        await this.clearStreamingState();
        return;

      case 'exportLogs':
        await this.exportStreamingLogs();
        return;

      case 'terminateProcess':
        await this.terminateProcess(message.processId);
        return;
    }
  }

  public async handleEnhancedQuery(query: string, useStreaming: boolean = true) {
    if (!this._view) return;

    const activeEditor = vscode.window.activeTextEditor;
    const targetFilePath = activeEditor?.document.uri.fsPath || '';

    let workspacePath = '';
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      this.outputChannel.appendLine(`[WORKSPACE] Using workspace path: ${workspacePath}`);
    } else {
      const errorMessage = 'No workspace folder is open. Please open a folder or workspace first.';
      this.updateResponse(`Error: ${errorMessage}`);
      this.outputChannel.appendLine(`Query error: ${errorMessage}`);
      vscode.window.showErrorMessage(errorMessage, 'Open Folder').then(selection => {
        if (selection === 'Open Folder') {
          vscode.commands.executeCommand('vscode.openFolder');
        }
      });
      return;
    }

    console.log('workspacePath:', workspacePath);

    try {
      if (useStreaming && this.enhancedStreamingClient) {
        // Use TRUE streaming API with enhanced visualization
        this.outputChannel.appendLine(`🚀 Using TRUE streaming API for query: ${query}`);
        this.outputChannel.appendLine(`📁 Workspace context: ${workspacePath}`);

        await this.enhancedStreamingClient.streamQuery(
          {
            query: query,
            target_file_path: targetFilePath,
            workspace_path: workspacePath
          },
          this._view.webview,
          // Custom event handler for additional processing
          async (event, state) => {
            // Log detailed event information
            this.outputChannel.appendLine(`[EVENT] ${event.type}: ${event.content.substring(0, 50)}...`);

            // Handle specific events for enhanced UX
            if (event.type === 'thinking' && event.content.length > 100) {
              // Show progress for long thinking sessions
              this.statusBarItem.text = `🧠 Thinking... (${event.content.length} chars)`;
            } else if (event.type === 'tool_selection') {
              // Highlight tool selection in output
              this.outputChannel.appendLine(`🔧 TOOL SELECTED: ${event.metadata?.tool_name}`);
            } else if (event.type === 'final_response') {
              // Mark completion
              this.outputChannel.appendLine('✅ TRUE streaming query completed');
              this.statusBarItem.text = '$(plug) Agent Server (Enhanced)';
            }
          }
        );
      } else {
        // Fallback to original API
        this.outputChannel.appendLine(`Using original API for query: ${query}`);
        this.updateResponse('Processing your query with original API...');

        const response = await this.callOriginalAgent(query, targetFilePath, workspacePath);
        this.updateResponse(response);
      }
    } catch (error) {
      console.error('Error processing enhanced query:', error);
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.updateResponse(errorMessage);
      this.outputChannel.appendLine(`Enhanced query error: ${errorMessage}`);
    }
  }

  private async checkEnhancedStreamingHealth() {
    if (!this.enhancedStreamingClient || !this._view) return;

    try {
      const isHealthy = await this.enhancedStreamingClient.checkHealth();

      this._view.webview.postMessage({
        command: 'enhancedStreamingHealthStatus',
        isHealthy: isHealthy,
        url: STREAMING_API_URL,
        features: {
          trueStreaming: true,
          thinkingVisualization: true,
          toolTracking: true,
          permissionHandling: true
        }
      });

      if (isHealthy) {
        this.outputChannel.appendLine('✅ Enhanced TRUE Streaming API is healthy');
        this.statusBarItem.text = '$(plug) Agent Server (Enhanced TRUE Streaming)';
      } else {
        this.outputChannel.appendLine('❌ Enhanced TRUE Streaming API is not available');
        this.statusBarItem.text = '$(plug) Agent Server (Original)';
      }
    } catch (error) {
      this.outputChannel.appendLine(`❌ Enhanced streaming health check failed: ${error}`);
      this.statusBarItem.text = '$(plug) Agent Server (Original)';

      this._view.webview.postMessage({
        command: 'enhancedStreamingHealthStatus',
        isHealthy: false,
        url: STREAMING_API_URL,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private updateResponse(text: string) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'response',
        text: text
      });
    }
  }

  private async callOriginalAgent(query: string, targetFilePath: string, workspacePath: string): Promise<string> {
    try {
      // Call the original Python agent API
      const response = await axios.post(`${AGENT_API_URL}/query`, {
        query,
        target_file_path: targetFilePath,
        workspace_path: workspacePath
      });

      return response.data.response || 'No response from agent';
    } catch (error: unknown) {
      console.error('Error calling original agent API:', error);
      if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
        return 'Agent server is not running. Please start the agent server first.';
      }
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public async refreshEnhancedStreamingConnection() {
    await this.checkEnhancedStreamingHealth();
  }

  private async handlePermissionResponse(permissionId: string, granted: boolean) {
    try {
      if (this.enhancedStreamingClient) {
        await this.enhancedStreamingClient.sendPermissionResponse(permissionId, granted);
        this.outputChannel.appendLine(`[PERMISSION] Enhanced response sent: ${granted ? 'Granted' : 'Denied'} for ${permissionId}`);
      }
    } catch (error) {
      this.outputChannel.appendLine(`[PERMISSION] Enhanced error sending response: ${error}`);
      console.error('Error sending enhanced permission response:', error);
    }
  }

  private async clearStreamingState() {
    if (this.enhancedStreamingClient) {
      this.enhancedStreamingClient.resetCurrentState();
      this.outputChannel.appendLine('[STATE] Enhanced streaming state cleared');

      if (this._view) {
        this._view.webview.postMessage({
          command: 'stateCleared'
        });
      }
    }
  }

  private async exportStreamingLogs() {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found for exporting logs');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFileName = `enhanced-streaming-logs-${timestamp}.txt`;
      const logFilePath = path.join(workspaceFolder.uri.fsPath, logFileName);

      // Get current state
      const currentState = this.enhancedStreamingClient?.getCurrentState();

      const logContent = [
        '=== ENHANCED STREAMING LOGS ===',
        `Timestamp: ${new Date().toLocaleString()}`,
        `Streaming API URL: ${STREAMING_API_URL}`,
        '',
        '=== CURRENT STATE ===',
        JSON.stringify(currentState, null, 2),
        '',
        '=== OUTPUT CHANNEL LOGS ===',
        '(Check VSCode Output Channel for detailed logs)',
        '',
        '=== END OF LOGS ==='
      ].join('\n');

      await fs.promises.writeFile(logFilePath, logContent);

      vscode.window.showInformationMessage(
        `Enhanced streaming logs exported to: ${logFileName}`,
        'Open File'
      ).then(selection => {
        if (selection === 'Open File') {
          vscode.window.showTextDocument(vscode.Uri.file(logFilePath));
        }
      });

      this.outputChannel.appendLine(`[EXPORT] Logs exported to: ${logFilePath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to export logs: ${error}`);
      this.outputChannel.appendLine(`[EXPORT] Error: ${error}`);
    }
  }

  private async terminateProcess(processId: string) {
    if (!processId) {
      this.outputChannel.appendLine('❌ No process ID provided for termination');
      return;
    }

    try {
      if (this.enhancedStreamingClient) {
        // Call the terminate process endpoint
        const response = await axios.post(`${STREAMING_API_URL}/terminate_process`, {
          process_id: processId
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000
        });

        this.outputChannel.appendLine(`✅ Process termination request sent for ${processId}`);
        this.outputChannel.appendLine(`Server response: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      this.outputChannel.appendLine(`❌ Error terminating process: ${error}`);
      console.error('Error terminating process:', error);
    }
  }

  private getEnhancedWebviewContent(webview: vscode.Webview): string {
    // Use the proper React webview content from utilities
    return getWebviewContent(webview, this._extensionUri);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Enhanced Assistant Sidebar extension with TRUE streaming support');

  // Create output channel for logging
  const outputChannel = vscode.window.createOutputChannel('Enhanced Agent Assistant');

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(plug) Enhanced Agent Server';
  statusBarItem.tooltip = 'Enhanced Agent Server Status (TRUE Streaming)';
  statusBarItem.command = 'enhanced-assistant-sidebar.refreshConnection';
  statusBarItem.show();

  const provider = new EnhancedAssistantViewProvider(context.extensionUri, outputChannel, statusBarItem);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EnhancedAssistantViewProvider.viewType,
      provider
    )
  );

  // Register enhanced commands
  context.subscriptions.push(
    vscode.commands.registerCommand('enhanced-assistant-sidebar.sendQuery', () => {
      vscode.window.showInformationMessage('Enhanced Send Query command executed');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.startStreamingServer', async () => {
      try {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) {
          throw new Error('No workspace folder is open');
        }

        outputChannel.appendLine(`[SERVER] Starting streaming server from workspace: ${workspacePath}`);

        // Run the streaming agent server from the user's workspace directory
        // The agent script should be accessible via relative path from the workspace
        const terminal = vscode.window.createTerminal('Enhanced Streaming Agent Server');

        // First change to the user's workspace, then run the agent script
        // Assuming the extension is in the workspace under assistant-sidebar/
        terminal.sendText(`cd "${workspacePath}"`);
        terminal.sendText(`echo "Starting streaming server from: $(pwd)"`);
        terminal.sendText(`python3 system/coding_agent/agent_streaming_api.py`);
        terminal.show();

        outputChannel.appendLine(`[SERVER] Terminal commands sent to start server from ${workspacePath}`);
        vscode.window.showInformationMessage('Enhanced TRUE streaming agent server started from workspace');

        // Wait a bit and then check health
        setTimeout(() => {
          provider.refreshEnhancedStreamingConnection();
        }, 3000);
      } catch (error) {
        const errorMessage = `Failed to start enhanced streaming server: ${error instanceof Error ? error.message : String(error)}`;
        outputChannel.appendLine(`[SERVER ERROR] ${errorMessage}`);
        vscode.window.showErrorMessage(errorMessage);
      }
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.refreshConnection', async () => {
      await provider.refreshEnhancedStreamingConnection();
      vscode.window.showInformationMessage('Enhanced connection status refreshed');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.showOutput', () => {
      outputChannel.show();
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.askAgent', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'What would you like to ask the enhanced agent?',
        placeHolder: 'Enter your question or request...'
      });

      if (query) {
        // This will use the enhanced TRUE streaming API
        await provider.handleEnhancedQuery(query, true);
      }
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.clearState', async () => {
      // Clear the streaming state
      outputChannel.appendLine('[COMMAND] Clearing enhanced streaming state...');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.exportLogs', async () => {
      // Export streaming logs
      outputChannel.appendLine('[COMMAND] Exporting enhanced streaming logs...');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.openWorkspace', async () => {
      // Command to help users open a workspace when debugging
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Open Workspace Folder'
      });

      if (result && result[0]) {
        await vscode.commands.executeCommand('vscode.openFolder', result[0]);
      }
    })
  );

  context.subscriptions.push(outputChannel, statusBarItem);

  console.log('Enhanced Assistant Sidebar extension activated with TRUE streaming support');
}

export function deactivate() {
  // Clean up any resources here
} 