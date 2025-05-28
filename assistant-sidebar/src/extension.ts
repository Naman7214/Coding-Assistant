import * as vscode from 'vscode';
import * as http from 'http';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewContent, getNonce } from './utilities';

const AGENT_API_PORT = 5000; // Port for the Python agent API
const AGENT_API_URL = 'http://0.0.0.0:5000'

interface WebviewMessage {
  command: string;
  text: string;
}

class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'assistantView';
  private _view?: vscode.WebviewView;
  private agentServer?: http.Server;
  private isAgentRunning = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        switch (message.command) {
          case 'sendQuery':
            // Show loading indicator
            this.updateResponse('Processing your query...');
            
            try {
              const activeEditor = vscode.window.activeTextEditor;
              const targetFilePath = activeEditor?.document.uri.fsPath || '';
              
              // Get the workspace folder path
              let workspacePath = '';
              if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
              } else {
                throw new Error('No workspace folder is open');
              }
              
              // Call the agent with the query, current file path, and workspace path
              const response = await this.callAgent(message.text, targetFilePath, workspacePath);
              
              // Update the response in the webview
              this.updateResponse(response);
            } catch (error) {
              console.error('Error calling agent:', error);
              this.updateResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
            }
            
            return;
        }
      }
    );
  }

  private updateResponse(text: string) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'response',
        text: text
      });
    }
  }
  
  private async callAgent(query: string, targetFilePath: string, workspacePath: string): Promise<string> {
    try {

      console.log('Workspace path:', workspacePath);
      // Call the Python agent API with workspace path
      const response = await axios.post(`${AGENT_API_URL}/query`, {
        query,
        target_file_path: targetFilePath,
        workspace_path: workspacePath
      });
      
      return response.data.response || 'No response from agent';
    } catch (error: unknown) {
      console.error('Error calling agent API:', error);
      if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
        return 'Agent server is not running. Please start the agent server first.';
      }
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private getWorkspaceInfo(): { workspacePath: string; openFiles: string[] } {
    let workspacePath = '';
    const openFiles: string[] = [];

    // Get workspace path
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    // Get list of open files
    vscode.workspace.textDocuments.forEach(doc => {
      if (doc.uri.scheme === 'file') {
        openFiles.push(doc.uri.fsPath);
      }
    });

    return { workspacePath, openFiles };
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Assistant Sidebar extension');
  
  const provider = new AssistantViewProvider(context.extensionUri);
  
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
        // Get workspace path
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) {
          throw new Error('No workspace folder is open');
        }

        // Run a command to start the Python agent server with workspace path
        const terminal = vscode.window.createTerminal('Agent Server');
        terminal.sendText(`cd system/coding_agent && python3 agent_api.py --workspace "${workspacePath}"`);
        terminal.show();
        vscode.window.showInformationMessage('Agent server started');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start agent server: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );
  
  // Create a status bar item to show server status
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(plug) Agent Server';
  statusBarItem.tooltip = 'Start/Stop Agent Server';
  statusBarItem.command = 'assistant-sidebar.startAgentServer';
  statusBarItem.show();
  
  context.subscriptions.push(statusBarItem);
  
  console.log('Assistant Sidebar extension activated');
}

export function deactivate() {
  // Clean up any resources here
} 