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

// Enhanced workspace context interfaces
interface OpenFileInfo {
  path: string;
  relativePath: string;
  content: string;
  languageId: string;
  isDirty: boolean;
  isUntitled: boolean;
  cursorPosition?: vscode.Position;
  selection?: vscode.Selection;
  lineCount: number;
  fileSize: number;
}

interface CurrentFileInfo extends OpenFileInfo {
  visibleRanges: readonly vscode.Range[];
  selections: readonly vscode.Selection[];
}

interface WorkspaceContext {
  workspacePath: string;
  workspaceName: string;
  currentFile: CurrentFileInfo | null;
  openFiles: OpenFileInfo[];
  recentlyModifiedFiles: string[];
  gitInfo?: {
    branch: string;
    hasChanges: boolean;
    changedFiles: string[];
  };
  totalOpenFiles: number;
  totalWorkspaceFiles?: number;
}

// Lightweight version for API requests (without full file contents)
interface LightweightWorkspaceContext {
  workspacePath: string;
  workspaceName: string;
  currentFile: {
    path: string;
    relativePath: string;
    languageId: string;
    isDirty: boolean;
    cursorPosition?: vscode.Position;
    lineCount: number;
    fileSize: number;
  } | null;
  openFiles: Array<{
    path: string;
    relativePath: string;
    languageId: string;
    isDirty: boolean;
    lineCount: number;
    fileSize: number;
  }>;
  recentlyModifiedFiles: string[];
  gitInfo?: {
    branch: string;
    hasChanges: boolean;
    changedFiles: string[];
  };
  totalOpenFiles: number;
  totalWorkspaceFiles?: number;
}

// Workspace Context Manager
class WorkspaceContextManager {
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Captures comprehensive workspace context including all open files and current file
   */
  async captureWorkspaceContext(): Promise<WorkspaceContext> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('No workspace folder is open');
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const workspaceName = workspaceFolder.name;

    this.outputChannel.appendLine(`[CONTEXT] Capturing workspace context for: ${workspaceName}`);

    // Get current file info
    const currentFile = await this.getCurrentFileInfo();

    // Get all open files
    const openFiles = await this.getAllOpenFiles();

    // Get recently modified files
    const recentlyModifiedFiles = await this.getRecentlyModifiedFiles();

    // Get git info (if available)
    const gitInfo = await this.getGitInfo();

    // Count total workspace files (async, don't wait for it)
    const totalWorkspaceFiles = await this.countWorkspaceFiles().catch(() => undefined);

    const context: WorkspaceContext = {
      workspacePath,
      workspaceName,
      currentFile,
      openFiles,
      recentlyModifiedFiles,
      gitInfo,
      totalOpenFiles: openFiles.length,
      totalWorkspaceFiles
    };

    this.outputChannel.appendLine(`[CONTEXT] Captured ${openFiles.length} open files, current file: ${currentFile?.path || 'none'}`);

    return context;
  }

  /**
   * Gets detailed information about the currently active file
   */
  private async getCurrentFileInfo(): Promise<CurrentFileInfo | null> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return null;
    }

    const document = activeEditor.document;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    const relativePath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
      : document.uri.fsPath;

    const content = document.getText();

    return {
      path: document.uri.fsPath,
      relativePath,
      content,
      languageId: document.languageId,
      isDirty: document.isDirty,
      isUntitled: document.isUntitled,
      cursorPosition: activeEditor.selection.active,
      selection: activeEditor.selection,
      lineCount: document.lineCount,
      fileSize: Buffer.byteLength(content, 'utf8'),
      visibleRanges: activeEditor.visibleRanges,
      selections: activeEditor.selections
    };
  }

  /**
   * Gets information about all currently open files
   */
  private async getAllOpenFiles(): Promise<OpenFileInfo[]> {
    const openFiles: OpenFileInfo[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // Get all open text documents
    for (const document of vscode.workspace.textDocuments) {
      // Skip system files and output channels
      if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
        continue;
      }

      const relativePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
        : document.uri.fsPath;

      // Find the corresponding editor for cursor position
      const editor = vscode.window.visibleTextEditors.find(e => e.document === document);

      const content = document.getText();

      openFiles.push({
        path: document.uri.fsPath,
        relativePath,
        content,
        languageId: document.languageId,
        isDirty: document.isDirty,
        isUntitled: document.isUntitled,
        cursorPosition: editor?.selection.active,
        selection: editor?.selection,
        lineCount: document.lineCount,
        fileSize: Buffer.byteLength(content, 'utf8')
      });
    }

    return openFiles;
  }

  /**
   * Gets list of recently modified files in the workspace
   */
  private async getRecentlyModifiedFiles(): Promise<string[]> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return [];

      // Get recently modified files using VS Code's file system API
      const recentFiles: string[] = [];

      // Check for dirty (unsaved) documents first
      for (const document of vscode.workspace.textDocuments) {
        if (document.isDirty && document.uri.scheme === 'file') {
          const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
          recentFiles.push(relativePath);
        }
      }

      return recentFiles;
    } catch (error) {
      this.outputChannel.appendLine(`[CONTEXT] Error getting recently modified files: ${error}`);
      return [];
    }
  }

  /**
   * Gets git information if available
   */
  private async getGitInfo(): Promise<WorkspaceContext['gitInfo']> {
    try {
      // Try to use VS Code's built-in git extension API
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) {
        return undefined;
      }

      const git = gitExtension.exports.getAPI(1);
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      if (!workspaceFolder) {
        return undefined;
      }

      const repository = git.getRepository(workspaceFolder.uri);
      if (!repository) {
        return undefined;
      }

      return {
        branch: repository.state.HEAD?.name || 'unknown',
        hasChanges: repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0,
        changedFiles: [
          ...repository.state.workingTreeChanges.map((change: any) => change.uri.fsPath),
          ...repository.state.indexChanges.map((change: any) => change.uri.fsPath)
        ].map(filePath => {
          return path.relative(workspaceFolder.uri.fsPath, filePath);
        })
      };
    } catch (error) {
      this.outputChannel.appendLine(`[CONTEXT] Error getting git info: ${error}`);
      return undefined;
    }
  }

  /**
   * Counts total files in workspace (for context)
   */
  private async countWorkspaceFiles(): Promise<number> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return 0;

      const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1000);
      return files.length;
    } catch (error) {
      this.outputChannel.appendLine(`[CONTEXT] Error counting workspace files: ${error}`);
      return 0;
    }
  }

  /**
   * Gets file content by path (helper method)
   */
  async getFileContent(filePath: string): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      return document.getText();
    } catch (error) {
      // Fallback to fs if document is not available
      return await fs.promises.readFile(filePath, 'utf8');
    }
  }

  /**
   * Gets summary of workspace context for logging
   */
  getContextSummary(context: WorkspaceContext): string {
    return [
      `Workspace: ${context.workspaceName} (${context.workspacePath})`,
      `Current file: ${context.currentFile?.relativePath || 'none'}`,
      `Open files: ${context.totalOpenFiles}`,
      `Total workspace files: ${context.totalWorkspaceFiles || 'unknown'}`,
      `Git branch: ${context.gitInfo?.branch || 'none'}`,
      `Git changes: ${context.gitInfo?.hasChanges ? 'yes' : 'no'}`,
      `Recently modified: ${context.recentlyModifiedFiles.length} files`
    ].join('\n');
  }

  /**
   * Creates a lightweight version of workspace context for API requests
   */
  createLightweightContext(context: WorkspaceContext): LightweightWorkspaceContext {
    return {
      workspacePath: context.workspacePath,
      workspaceName: context.workspaceName,
      currentFile: context.currentFile ? {
        path: context.currentFile.path,
        relativePath: context.currentFile.relativePath,
        languageId: context.currentFile.languageId,
        isDirty: context.currentFile.isDirty,
        cursorPosition: context.currentFile.cursorPosition,
        lineCount: context.currentFile.lineCount,
        fileSize: context.currentFile.fileSize
      } : null,
      openFiles: context.openFiles.map(file => ({
        path: file.path,
        relativePath: file.relativePath,
        languageId: file.languageId,
        isDirty: file.isDirty,
        lineCount: file.lineCount,
        fileSize: file.fileSize
      })),
      recentlyModifiedFiles: context.recentlyModifiedFiles,
      gitInfo: context.gitInfo,
      totalOpenFiles: context.totalOpenFiles,
      totalWorkspaceFiles: context.totalWorkspaceFiles
    };
  }
}

class EnhancedAssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'enhancedAssistantView';
  private _view?: vscode.WebviewView;
  private agentServer?: http.Server;
  private isAgentRunning = false;
  private enhancedStreamingClient?: EnhancedStreamingClient;
  private outputChannel: vscode.OutputChannel;
  private statusBarItem: vscode.StatusBarItem;
  private workspaceContextManager: WorkspaceContextManager;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem
  ) {
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
    this.workspaceContextManager = new WorkspaceContextManager(outputChannel);
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

    // Listen for file changes to update context
    this.setupFileChangeListeners();

    // Check streaming server health on startup
    this.checkEnhancedStreamingHealth();
  }

  /**
   * Sets up listeners for file changes to keep context updated
   */
  private setupFileChangeListeners() {
    // Listen for active editor changes
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.outputChannel.appendLine('[CONTEXT] Active editor changed');
    });

    // Listen for text document changes
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file') {
        this.outputChannel.appendLine(`[CONTEXT] Document changed: ${event.document.fileName}`);
      }
    });

    // Listen for file operations
    vscode.workspace.onDidCreateFiles((event) => {
      this.outputChannel.appendLine(`[CONTEXT] Files created: ${event.files.map(f => f.fsPath).join(', ')}`);
    });

    vscode.workspace.onDidDeleteFiles((event) => {
      this.outputChannel.appendLine(`[CONTEXT] Files deleted: ${event.files.map(f => f.fsPath).join(', ')}`);
    });
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

      case 'refreshContext':
        await this.refreshWorkspaceContext();
        return;

      case 'exportContext':
        await this.exportWorkspaceContext();
        return;
    }
  }

  public async handleEnhancedQuery(query: string, useStreaming: boolean = true) {
    if (!this._view) return;

    try {
      // Capture comprehensive workspace context
      this.outputChannel.appendLine('[CONTEXT] Capturing comprehensive workspace context...');
      const workspaceContext = await this.workspaceContextManager.captureWorkspaceContext();

      // Log context summary
      const contextSummary = this.workspaceContextManager.getContextSummary(workspaceContext);
      this.outputChannel.appendLine(`[CONTEXT] Summary:\n${contextSummary}`);

      // Send context to webview for display
      if (this._view) {
        this._view.webview.postMessage({
          command: 'workspaceContext',
          context: workspaceContext
        });
      }

      if (useStreaming && this.enhancedStreamingClient) {
        // Use TRUE streaming API with lightweight workspace context
        this.outputChannel.appendLine(`🚀 Using TRUE streaming API for query: ${query}`);

        // Create lightweight context for the API request
        const lightweightContext = this.workspaceContextManager.createLightweightContext(workspaceContext);

        // Log payload size for debugging
        const payloadSize = JSON.stringify(lightweightContext).length;
        this.outputChannel.appendLine(`[DEBUG] Lightweight context payload size: ${lightweightContext}`);
        this.outputChannel.appendLine(`[DEBUG] Lightweight context payload size: ${payloadSize} bytes`);
        this.outputChannel.appendLine(`[DEBUG] Open files: ${lightweightContext.openFiles.length}, Current file: ${lightweightContext.currentFile?.relativePath || 'none'}`);

        // Prepare request with optional workspace context
        const streamRequest: any = {
          query: query,
          target_file_path: workspaceContext.currentFile?.path || '',
          workspace_path: workspaceContext.workspacePath
        };

        // Add workspace context only if payload is reasonable size (< 100KB)
        if (payloadSize < 100000) {
          streamRequest.workspace_context = lightweightContext;
          this.outputChannel.appendLine(`[DEBUG] Including workspace context in request`);
        } else {
          this.outputChannel.appendLine(`[DEBUG] Payload too large (${payloadSize} bytes), sending basic request`);
        }

        await this.enhancedStreamingClient.streamQuery(
          streamRequest,
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
        // Fallback to original API with enhanced context
        this.outputChannel.appendLine(`Using original API for query: ${query}`);
        this.updateResponse('Processing your query with enhanced context...');

        const response = await this.callOriginalAgent(
          query,
          workspaceContext.currentFile?.path || '',
          workspaceContext.workspacePath,
          workspaceContext
        );
        this.updateResponse(response);
      }
    } catch (error) {
      console.error('Error processing enhanced query:', error);
      const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.updateResponse(errorMessage);
      this.outputChannel.appendLine(`Enhanced query error: ${errorMessage}`);

      // Show helpful error message for workspace issues
      if (error instanceof Error && error.message.includes('No workspace folder')) {
        vscode.window.showErrorMessage(
          'No workspace folder is open. Please open a folder or workspace first.',
          'Open Folder'
        ).then(selection => {
          if (selection === 'Open Folder') {
            vscode.commands.executeCommand('vscode.openFolder');
          }
        });
      }
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

  private async callOriginalAgent(query: string, targetFilePath: string, workspacePath: string, workspaceContext: WorkspaceContext): Promise<string> {
    try {
      // Call the original Python agent API
      const response = await axios.post(`${AGENT_API_URL}/query`, {
        query,
        target_file_path: targetFilePath,
        workspace_path: workspacePath,
        workspace_context: workspaceContext
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

  /**
   * Refreshes the workspace context and sends it to the webview
   */
  private async refreshWorkspaceContext() {
    try {
      const workspaceContext = await this.workspaceContextManager.captureWorkspaceContext();
      const contextSummary = this.workspaceContextManager.getContextSummary(workspaceContext);

      this.outputChannel.appendLine(`[CONTEXT] Refreshed context:\n${contextSummary}`);

      if (this._view) {
        this._view.webview.postMessage({
          command: 'workspaceContextRefreshed',
          context: workspaceContext
        });
      }
    } catch (error) {
      this.outputChannel.appendLine(`[CONTEXT] Error refreshing context: ${error}`);
    }
  }

  /**
   * Exports the current workspace context to a file
   */
  private async exportWorkspaceContext() {
    try {
      const workspaceContext = await this.workspaceContextManager.captureWorkspaceContext();
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found for exporting context');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const contextFileName = `workspace-context-${timestamp}.json`;
      const contextFilePath = path.join(workspaceFolder.uri.fsPath, contextFileName);

      // Create a sanitized version of the context for export (without full file contents)
      const exportContext = {
        ...workspaceContext,
        currentFile: workspaceContext.currentFile ? {
          ...workspaceContext.currentFile,
          content: `[Content Length: ${workspaceContext.currentFile.content.length} characters]`
        } : null,
        openFiles: workspaceContext.openFiles.map(file => ({
          ...file,
          content: `[Content Length: ${file.content.length} characters]`
        }))
      };

      await fs.promises.writeFile(contextFilePath, JSON.stringify(exportContext, null, 2));

      vscode.window.showInformationMessage(
        `Workspace context exported to: ${contextFileName}`,
        'Open File'
      ).then(selection => {
        if (selection === 'Open File') {
          vscode.window.showTextDocument(vscode.Uri.file(contextFilePath));
        }
      });

      this.outputChannel.appendLine(`[EXPORT] Context exported to: ${contextFilePath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to export workspace context: ${error}`);
      this.outputChannel.appendLine(`[EXPORT] Context export error: ${error}`);
    }
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

    vscode.commands.registerCommand('enhanced-assistant-sidebar.refreshContext', async () => {
      // Refresh workspace context
      outputChannel.appendLine('[COMMAND] Refreshing workspace context...');
      // Note: This will be handled via webview message, but we provide a command palette option
      vscode.window.showInformationMessage('Workspace context refreshed');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.exportContext', async () => {
      // Export workspace context
      outputChannel.appendLine('[COMMAND] Exporting workspace context...');
      // Note: This will be handled via webview message, but we provide a command palette option
      vscode.window.showInformationMessage('Workspace context export initiated');
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