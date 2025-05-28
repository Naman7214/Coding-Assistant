import * as vscode from 'vscode';
import * as http from 'http';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent, getNonce } from './utilities';
import { AgentStreamingClient } from './streaming_client';

const AGENT_API_PORT = 5000; // Port for the Python agent API (original)
const STREAMING_API_PORT = 5001; // Port for the streaming API
const AGENT_API_URL = 'http://0.0.0.0:5000';
const STREAMING_API_URL = 'http://0.0.0.0:5001';

class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'assistantView';
  private _view?: vscode.WebviewView;
  private agentServer?: http.Server;
  private isAgentRunning = false;
  private streamingClient?: AgentStreamingClient;
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

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri);

    // Initialize streaming client
    this.streamingClient = new AgentStreamingClient(
      STREAMING_API_URL,
      this.outputChannel,
      this.statusBarItem
    );

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'sendQuery':
            await this.handleQuery(message.text, message.useStreaming);
            return;
          
          case 'checkStreamingHealth':
            await this.checkStreamingHealth();
            return;
            
          case 'permissionResponse':
            await this.handlePermissionResponse(message.permissionId, message.granted);
            return;
        }
      }
    );

    // Check streaming server health on startup
    this.checkStreamingHealth();
  }

  public async handleQuery(query: string, useStreaming: boolean = true) {
    if (!this._view) return;

    const activeEditor = vscode.window.activeTextEditor;
    const targetFilePath = activeEditor?.document.uri.fsPath || '';

    try {
      if (useStreaming && this.streamingClient) {
        // Use streaming API
        this.outputChannel.appendLine(`Using streaming API for query: ${query}`);
        
        await this.streamingClient.streamQuery(
          {
            query: query,
            target_file_path: targetFilePath
          },
          this._view.webview,
          // Custom event handler for additional processing
          async (event) => {
            // You can add custom logic here for specific events
            if (event.type === 'final_response') {
              this.outputChannel.appendLine('Streaming query completed');
            }
          }
        );
      } else {
        // Fallback to original API
        this.outputChannel.appendLine(`Using original API for query: ${query}`);
        this.updateResponse('Processing your query...');
        
        const response = await this.callOriginalAgent(query, targetFilePath);
        this.updateResponse(response);
      }
    } catch (error) {
      console.error('Error processing query:', error);
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.updateResponse(errorMessage);
      this.outputChannel.appendLine(`Query error: ${errorMessage}`);
    }
  }

  private async checkStreamingHealth() {
    if (!this.streamingClient || !this._view) return;

    try {
      const isHealthy = await this.streamingClient.checkHealth();
      
      this._view.webview.postMessage({
        command: 'streamingHealthStatus',
        isHealthy: isHealthy,
        url: STREAMING_API_URL
      });

      if (isHealthy) {
        this.outputChannel.appendLine('✅ Streaming API is healthy');
        this.statusBarItem.text = '$(plug) Agent Server (Streaming)';
      } else {
        this.outputChannel.appendLine('❌ Streaming API is not available');
        this.statusBarItem.text = '$(plug) Agent Server (Original)';
      }
    } catch (error) {
      this.outputChannel.appendLine(`❌ Streaming health check failed: ${error}`);
      this.statusBarItem.text = '$(plug) Agent Server (Original)';
      
      this._view.webview.postMessage({
        command: 'streamingHealthStatus',
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
  
  private async callOriginalAgent(query: string, targetFilePath: string): Promise<string> {
    try {
      // Call the original Python agent API
      const response = await axios.post(`${AGENT_API_URL}/query`, {
        query,
        target_file_path: targetFilePath
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

  public async refreshStreamingConnection() {
    await this.checkStreamingHealth();
  }

  private async handlePermissionResponse(permissionId: string, granted: boolean) {
    try {
      // Forward the permission response to the streaming API
      const response = await axios.post(`${STREAMING_API_URL}/permission`, {
        permission_id: permissionId,
        granted: granted
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      this.outputChannel.appendLine(`[PERMISSION] Response sent: ${granted ? 'Granted' : 'Denied'} for ${permissionId}`);
    } catch (error) {
      this.outputChannel.appendLine(`[PERMISSION] Error sending response: ${error}`);
      console.error('Error sending permission response:', error);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Assistant Sidebar extension with streaming support');
  
  // Create output channel for logging
  const outputChannel = vscode.window.createOutputChannel('Agent Assistant');
  
  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(plug) Agent Server';
  statusBarItem.tooltip = 'Agent Server Status';
  statusBarItem.command = 'assistant-sidebar.refreshConnection';
  statusBarItem.show();
  
  const provider = new AssistantViewProvider(context.extensionUri, outputChannel, statusBarItem);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AssistantViewProvider.viewType, 
      provider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('assistant-sidebar.sendQuery', () => {
      vscode.window.showInformationMessage('Send Query command executed');
    }),
    
    vscode.commands.registerCommand('assistant-sidebar.startAgentServer', async () => {
      try {
        // Run a command to start the Python agent server
        const terminal = vscode.window.createTerminal('Agent Server');
        terminal.sendText('cd system/coding_agent && python3 agent_api.py');
        terminal.show();
        vscode.window.showInformationMessage('Original agent server started');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start agent server: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),

    vscode.commands.registerCommand('assistant-sidebar.startStreamingServer', async () => {
      try {
        // Run a command to start the streaming agent server
        const terminal = vscode.window.createTerminal('Streaming Agent Server');
        terminal.sendText('cd system/coding_agent && python3 agent_streaming_api.py');
        terminal.show();
        vscode.window.showInformationMessage('Streaming agent server started');
        
        // Wait a bit and then check health
        setTimeout(() => {
          provider.refreshStreamingConnection();
        }, 3000);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start streaming server: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),

    vscode.commands.registerCommand('assistant-sidebar.refreshConnection', async () => {
      await provider.refreshStreamingConnection();
      vscode.window.showInformationMessage('Connection status refreshed');
    }),

    vscode.commands.registerCommand('assistant-sidebar.showOutput', () => {
      outputChannel.show();
    }),

    vscode.commands.registerCommand('assistant-sidebar.askAgent', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'What would you like to ask the agent?',
        placeHolder: 'Enter your question or request...'
      });
      
      if (query) {
        // This will use the streaming API by default
        await provider.handleQuery(query, true);
      }
    })
  );
  
  context.subscriptions.push(outputChannel, statusBarItem);
  
  console.log('Assistant Sidebar extension activated with streaming support');
}

export function deactivate() {
  // Clean up any resources here
} 