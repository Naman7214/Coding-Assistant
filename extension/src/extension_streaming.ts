import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ContextApiServer } from './api/ContextApiServer';
import { ContextManager } from './context/ContextManager';
import { ProcessedContext } from './context/types/context';
import { IndexingManager, IndexingStatusInfo, hashWorkspacePath } from './indexing';
import { EnhancedStreamingClient } from './streaming_client';
import { getWebviewContent } from './utilities';

const execAsync = promisify(exec);

const STREAMING_API_URL = 'http://0.0.0.0:5001';

class EnhancedAssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'enhancedAssistantView';
  private _view?: vscode.WebviewView;
  private enhancedStreamingClient?: EnhancedStreamingClient;
  private outputChannel: vscode.OutputChannel;
  private statusBarItem: vscode.StatusBarItem;
  private context: vscode.ExtensionContext;
  private contextManager: ContextManager | null = null;
  private contextApiServer: ContextApiServer | null = null;
  private indexingManager: IndexingManager | null = null;
  private isContextManagerReady = false;
  private isIndexingReady = false;
  private workspaceDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem
  ) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;

    // Initialize context manager with proper workspace detection
    this.initializeContextManagerSafely();
  }

  /**
   * Safe context manager initialization that handles no workspace scenarios
   */
  private async initializeContextManagerSafely(): Promise<void> {
    try {
      this.outputChannel.appendLine('[Extension] Starting safe context manager initialization...');

      // Check if workspace is available
      const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;

      if (!hasWorkspace) {
        this.outputChannel.appendLine('[Extension] No workspace detected - context manager will initialize when workspace opens');
        this.setupWorkspaceWatcher();
        return;
      }

      // Check if context manager is already initialized or in progress
      if (this.contextManager !== null) {
        this.outputChannel.appendLine('[Extension] Context manager already exists, skipping initialization');
        return;
      }

      this.outputChannel.appendLine(`[Extension] Workspace detected: ${vscode.workspace.workspaceFolders![0].name}`);
      await this.createAndInitializeContextManager();

    } catch (error) {
      this.outputChannel.appendLine(`[Extension] Failed to setup context manager: ${error}`);
      this.outputChannel.appendLine(`[Extension] Error stack: ${error instanceof Error ? error.stack : 'No stack available'}`);
      this.setupWorkspaceWatcher(); // Fallback to workspace watcher
    }
  }

  /**
   * Create and initialize the context manager and API server
   */
  private async createAndInitializeContextManager(): Promise<void> {
    try {
      this.outputChannel.appendLine('[Extension] Creating context manager...');

      // Check if the context manager already exists
      if (this.contextManager !== null) {
        this.outputChannel.appendLine('[Extension] Context manager already exists, reusing existing instance');
        return;
      }

      // Initialize the context manager with safe defaults
      this.contextManager = new ContextManager(this.context, this.outputChannel, {
        enabled: true,
        autoCollectOnChange: false, // Disable auto-collect initially
        autoCollectInterval: 30000,
        defaultCollectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector', 'ProblemsCollector', 'RecentEditsCollector'],
        storageConfig: {
          enableStorage: true,
          enableCache: true
        }
      });

      this.outputChannel.appendLine('[Extension] Initializing context manager...');
      await this.contextManager.initialize();

      // Create and start API server only if it doesn't exist already
      if (!this.contextApiServer) {
        this.outputChannel.appendLine('[Extension] Creating Context API server...');
        this.contextApiServer = new ContextApiServer(
          this.contextManager,
          this.outputChannel
        );

        this.outputChannel.appendLine('[Extension] Starting Context API server...');
        await this.contextApiServer.start();
      } else {
        this.outputChannel.appendLine('[Extension] Context API server already exists');
      }

      this.isContextManagerReady = true;
      this.outputChannel.appendLine('[Extension] Context manager and API server ready');

      // Set up event listeners now that context manager is ready
      this.setupContextManagerEventListeners();

      // Initialize indexing manager alongside context manager
      await this.createAndInitializeIndexingManager();

      // Notify webview that context manager is now ready
      this.notifyWebviewContextManagerReady(true);

      // Update status bar
      this.updateStatusBar();

    } catch (error) {
      this.outputChannel.appendLine(`[Extension] Failed to initialize context systems: ${error}`);
      this.statusBarItem.text = '$(alert) Enhanced Assistant Error';

      // Notify webview about the error
      this.notifyWebviewContextManagerReady(false, `Initialization failed: ${error instanceof Error ? error.message : String(error)}`);

      throw error;
    }
  }

  /**
   * Create and initialize the indexing manager
   */
  private async createAndInitializeIndexingManager(): Promise<void> {
    try {
      this.outputChannel.appendLine('[Extension] Creating indexing manager...');

      // Check if the indexing manager already exists
      if (this.indexingManager !== null) {
        this.outputChannel.appendLine('[Extension] Indexing manager already exists, reusing existing instance');
        return;
      }

      // Initialize the indexing manager
      this.indexingManager = new IndexingManager(this.context, this.outputChannel, {
        enabled: true,
        indexingInterval: 10 * 60 * 1000, // 10 minutes
        maxFileSize: 1 * 1024 * 1024, // 1MB
        excludePatterns: [".venv/**", "node_modules/**", ".git/**", "dist/**", "build/**", "**/*.log"],
        serverUrl: 'http://localhost:8000' // Use the backend server URL
      });

      this.outputChannel.appendLine('[Extension] Initializing indexing manager...');
      await this.indexingManager.initialize();

      this.isIndexingReady = true;
      this.outputChannel.appendLine('[Extension] Indexing manager ready');

      // Set up indexing event listeners
      this.setupIndexingEventListeners();

      // Notify webview about indexing status
      this.notifyWebviewIndexingReady(true);

    } catch (error) {
      this.outputChannel.appendLine(`[Extension] Failed to initialize indexing manager: ${error}`);
      this.isIndexingReady = false;
      this.notifyWebviewIndexingReady(false, `Indexing initialization failed: ${error instanceof Error ? error.message : String(error)}`);

      // Don't throw error - indexing is optional
      this.outputChannel.appendLine('[Extension] Continuing without indexing...');
    }
  }

  /**
   * Setup workspace watcher for delayed initialization
   */
  private setupWorkspaceWatcher(): void {
    // Watch for workspace folder changes
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      if (event.added.length > 0 && !this.isContextManagerReady) {
        this.outputChannel.appendLine('[Extension] Workspace folder added - initializing context manager...');
        await this.createAndInitializeContextManager();
      }
      if (event.added.length > 0 && !this.isIndexingReady) {
        this.outputChannel.appendLine('[Extension] Workspace folder added - initializing indexing manager...');
        await this.createAndInitializeIndexingManager();
      }
    });

    this.workspaceDisposables.push(disposable);

    // Also check when workspace becomes available (for extension host restarts)
    const intervalCheck = setInterval(async () => {
      if (!this.isContextManagerReady && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        clearInterval(intervalCheck);
        this.outputChannel.appendLine('[Extension] Workspace detected via polling - initializing context manager...');
        await this.createAndInitializeContextManager();
      }
      if (!this.isIndexingReady && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        this.outputChannel.appendLine('[Extension] Workspace detected via polling - initializing indexing manager...');
        await this.createAndInitializeIndexingManager();
      }
    }, 2000); // Check every 2 seconds

    // Clear the interval after 30 seconds to avoid infinite polling
    setTimeout(() => {
      clearInterval(intervalCheck);
    }, 30000);
  }

  /**
   * Setup context manager event listeners
   */
  private setupContextManagerEventListeners(): void {
    if (!this.contextManager) return;

    this.contextManager.on('collectionCompleted', (event) => {
      if (this._view) {
        this._view.webview.postMessage({
          command: 'contextCollected',
          result: event.result,
          timestamp: event.timestamp
        });
      }
    });

    this.contextManager.on('fileChanged', (event) => {
      this.outputChannel.appendLine(`[Extension] File changed: ${event.relativePath}`);
    });

    this.contextManager.on('initialized', () => {
      this.outputChannel.appendLine('[Extension] Context manager initialization event received');
    });

    this.contextManager.on('error', (error) => {
      this.outputChannel.appendLine(`[Extension] Context manager error: ${error}`);
    });
  }

  /**
   * Notify webview about context manager status
   */
  private notifyWebviewContextManagerReady(ready: boolean, error?: string): void {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'contextManagerReady',
        ready,
        error
      });
    }
  }

  /**
   * Setup indexing manager event listeners
   */
  private setupIndexingEventListeners(): void {
    if (!this.indexingManager) return;

    this.indexingManager.on('statusChanged', (status: IndexingStatusInfo) => {
      if (this._view) {
        this._view.webview.postMessage({
          command: 'indexingStatusChanged',
          status
        });
      }
    });

    this.indexingManager.on('indexingCompleted', (event: any) => {
      this.outputChannel.appendLine(`[Extension] Indexing completed: ${event.chunks} chunks processed`);
      if (this._view) {
        this._view.webview.postMessage({
          command: 'indexingCompleted',
          chunks: event.chunks,
          timestamp: event.timestamp
        });
      }
    });

    this.indexingManager.on('initialized', (event: any) => {
      this.outputChannel.appendLine(`[Extension] Indexing initialized for workspace: ${event.workspaceHash}`);
    });
  }

  /**
   * Notify webview about indexing manager status
   */
  private notifyWebviewIndexingReady(ready: boolean, error?: string): void {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'indexingManagerReady',
        ready,
        error
      });
    }
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

    // Set up context manager event listeners if context manager exists
    this.setupContextManagerEventListeners();

    // Send initial context manager status - but handle the async initialization properly
    if (this.isContextManagerReady) {
      // Context manager is already ready
      this.notifyWebviewContextManagerReady(true);
    } else {
      // Check if we have a workspace and context manager is initializing
      const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
      if (hasWorkspace && this.contextManager) {
        // Context manager exists but not ready yet - notify initializing state
        this.notifyWebviewContextManagerReady(false, undefined);
        this.outputChannel.appendLine('[Extension] Webview resolved - context manager still initializing');
      } else if (!hasWorkspace) {
        // No workspace available
        this.notifyWebviewContextManagerReady(false, 'No workspace folder is open');
      } else {
        // No context manager yet - trigger initialization
        this.outputChannel.appendLine('[Extension] Webview resolved - triggering context manager initialization');
        this.initializeContextManagerSafely().then(() => {
          if (this.isContextManagerReady) {
            this.notifyWebviewContextManagerReady(true);
          }
        }).catch(error => {
          this.outputChannel.appendLine(`[Extension] Context manager initialization failed: ${error}`);
          this.notifyWebviewContextManagerReady(false, `Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  private async handleMessage(message: any) {
    switch (message.command) {
      case 'sendQuery':
        await this.handleQuery(message.text);
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


      case 'refreshContext':
        await this.refreshWorkspaceContext();
        return;

      case 'collectContext':
        await this.collectContextManually();
        return;

      case 'initializeWorkspace':
        await this.initializeForWorkspace();
        return;

      case 'handleQuery':
        await this.handleQuery(message.query);
        return;

      case 'handleContextRequest':
        await this.handleContextRequest(message.contextType, message.params);
        return;

      case 'getAvailableFiles':
        await this.getAvailableFiles();
        return;

      case 'getIndexingStatus':
        await this.getIndexingStatus();
        return;

      case 'triggerIndexing':
        await this.triggerIndexingManually();
        return;
    }
  }

  /**
   * Initialize context manager for workspace (called from webview)
   */
  private async initializeForWorkspace(): Promise<void> {
    if (this.isContextManagerReady) {
      this.outputChannel.appendLine('[Extension] Context manager already ready');
      this.notifyWebviewContextManagerReady(true);
      this.updateResponse('✅ Context manager is ready');
      return;
    }

    const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
    if (!hasWorkspace) {
      const errorMsg = 'No workspace folder is open. Please open a folder first.';
      this.outputChannel.appendLine(`[Extension] ${errorMsg}`);
      this.notifyWebviewContextManagerReady(false, errorMsg);
      this.updateResponse(`❌ ${errorMsg}`);

      // Show helpful message to user
      vscode.window.showWarningMessage(
        errorMsg,
        'Open Folder'
      ).then(selection => {
        if (selection === 'Open Folder') {
          vscode.commands.executeCommand('vscode.openFolder');
        }
      });
      return;
    }

    // Show progress to user
    this.updateResponse('🔄 Initializing context manager...');

    try {
      await this.createAndInitializeContextManager();

      if (this.isContextManagerReady) {
        this.updateResponse('✅ Context manager initialized successfully');
        this.outputChannel.appendLine('[Extension] Context manager initialization completed successfully');
      } else {
        this.updateResponse('❌ Failed to initialize context manager');
        this.outputChannel.appendLine('[Extension] Context manager initialization failed');
      }
    } catch (error) {
      const errorMsg = `Failed to initialize context manager: ${error instanceof Error ? error.message : String(error)}`;
      this.updateResponse(`❌ ${errorMsg}`);
      this.outputChannel.appendLine(`[Extension] Context manager initialization error: ${error}`);
      this.notifyWebviewContextManagerReady(false, errorMsg);
    }
  }

  /**
   * Handle queries from the UI
   */
  public async handleQuery(query: string) {
    if (!this._view) return;

    try {
      // Check workspace first
      const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
      if (!hasWorkspace) {
        this._view.webview.postMessage({
          command: 'streamError',
          error: 'No workspace is open. Please open a folder to enable workspace analysis.'
        });
        return;
      }

      // Initialize context manager if not ready
      if (!this.isContextManagerReady) {
        await this.initializeForWorkspace();
        if (!this.isContextManagerReady) {
          this._view.webview.postMessage({
            command: 'streamError',
            error: 'Failed to initialize context manager'
          });
          return;
        }
      }

      // Notify UI that streaming started
      this._view.webview.postMessage({
        command: 'streamStart'
      });

      // Parse @ mentions from query
      const contextMentions = this.parseContextMentions(query);
      this.outputChannel.appendLine(`[Query] Detected context mentions: ${JSON.stringify(contextMentions)}`);

      // Collect always-send context using ContextManager (includes system info + active file + open files + recent edits)
      const mustSendContexts = await this.contextManager!.collectMustSendContexts();

      // Extract data from must-send contexts
      const systemInfoData = mustSendContexts.get('systemInfo');
      const activeFileData = mustSendContexts.get('activeFile');
      const openFilesData = mustSendContexts.get('openFiles');
      const recentEditsData = mustSendContexts.get('recentEdits');

      // Get workspace info
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workspacePath = workspaceFolder?.uri.fsPath || '';

      // Get additional required data
      const hashedWorkspacePath = hashWorkspacePath(workspacePath);
      const currentGitBranch = await this.getCurrentGitBranch(workspacePath);

      // Log what context is being sent
      this.outputChannel.appendLine(`[Query] Always-send context summary:`);
      this.outputChannel.appendLine(`[Query] - System info: ${systemInfoData ? 'Available' : 'Not available'}`);
      this.outputChannel.appendLine(`[Query] - Active file: ${activeFileData?.data?.file?.relativePath || 'None'}`);
      this.outputChannel.appendLine(`[Query] - Open files: ${openFilesData?.data?.files?.length || 0} files`);
      this.outputChannel.appendLine(`[Query] - Recent edits: ${recentEditsData ? (recentEditsData.data.summary?.hasChanges ? `${recentEditsData.data.summary.totalFiles} files changed` : 'No recent changes') : 'Not available'}`);
      this.outputChannel.appendLine(`[Query] - Hashed workspace path: ${hashedWorkspacePath}`);
      this.outputChannel.appendLine(`[Query] - Git branch: ${currentGitBranch}`);
      this.outputChannel.appendLine(`[Query] - Context mentions: ${contextMentions.join(', ')}`);

      // Send query with always-send context to backend
      if (this.enhancedStreamingClient) {
        const streamRequest: any = {
          query: query,
          workspace_path: workspacePath,
          hashed_workspace_path: hashedWorkspacePath,
          git_branch: currentGitBranch,
          system_info: systemInfoData?.data || null,
          active_file_context: activeFileData?.data || null,
          open_files_context: openFilesData?.data?.files || [],
          recent_edits_context: recentEditsData?.data || null,
          context_mentions: contextMentions
        };

        const requestHeaders = {
          'X-Workspace-ID': this.contextManager!.getWorkspaceId()
        };

        // DEBUG: Log the exact request being sent
        this.outputChannel.appendLine(`[Query] Sending request with context mentions: ${JSON.stringify(contextMentions)}`);
        this.outputChannel.appendLine(`[Query] Workspace: ${streamRequest.workspace_path}`);
        this.outputChannel.appendLine(`[Query] Hashed workspace path: ${streamRequest.hashed_workspace_path}`);
        this.outputChannel.appendLine(`[Query] Git branch: ${streamRequest.git_branch}`);
        this.outputChannel.appendLine(`[Query] System Info: ${streamRequest.system_info ? 'Available' : 'Not available'}`);
        if (streamRequest.active_file_context?.file) {
          this.outputChannel.appendLine(`[Query] Active File: ${streamRequest.active_file_context.file.relativePath}`);
        }
        if (streamRequest.open_files_context && Array.isArray(streamRequest.open_files_context)) {
          this.outputChannel.appendLine(`[Query] Open Files: ${streamRequest.open_files_context.length} files`);
        }
        if (streamRequest.recent_edits_context) {
          this.outputChannel.appendLine(`[Query] Recent Edits: ${streamRequest.recent_edits_context.summary?.hasChanges ? `${streamRequest.recent_edits_context.summary.totalFiles} files changed` : 'No recent changes'}`);
        }

        // Stream the query with comprehensive event handling for App
        await this.enhancedStreamingClient.streamQuery(
          streamRequest,
          this._view.webview,
          async (event, state) => {
            this.outputChannel.appendLine(`[Query] Event: ${event.type} - ${event.content.substring(0, 100)}...`);

            // Comprehensive event handling for the App UI
            switch (event.type) {
              case 'thinking':
                // Forward thinking events to UI for transparency
                this._view!.webview.postMessage({
                  command: 'thinking',
                  content: event.content,
                  metadata: event.metadata
                });
                break;

              case 'tool_selection':
                this._view!.webview.postMessage({
                  command: 'toolSelection',
                  toolName: event.metadata?.tool_name,
                  content: event.content,
                  metadata: event.metadata
                });
                break;

              case 'tool_execution':
                this._view!.webview.postMessage({
                  command: 'toolExecution',
                  toolName: event.metadata?.tool_name,
                  content: event.content,
                  metadata: event.metadata
                });
                break;

              case 'tool_result':
                // Forward tool results for display
                this._view!.webview.postMessage({
                  command: 'toolResult',
                  toolName: event.metadata?.tool_name,
                  content: event.content,
                  isError: event.metadata?.error || false,
                  metadata: event.metadata
                });
                break;

              case 'assistant_response':
                this._view!.webview.postMessage({
                  command: 'responseUpdate',
                  content: event.content
                });
                break;

              case 'permission_request':
                // Handle permission requests - these come from the agent
                this._view!.webview.postMessage({
                  command: 'permissionRequest',
                  content: event.content,
                  permissionId: event.metadata?.permission_id,
                  terminalCommand: event.metadata?.command,
                  metadata: event.metadata
                });
                break;

              case 'final_response':
                this._view!.webview.postMessage({
                  command: 'streamComplete',
                  content: event.content
                });
                break;

              case 'error':
                this._view!.webview.postMessage({
                  command: 'streamError',
                  error: event.content,
                  metadata: event.metadata
                });
                break;

              case 'context_request':
                // Handle context requests from the agent
                this.outputChannel.appendLine(`[Query] Context request: ${event.metadata?.context_type}`);
                break;

              default:
                // Log unhandled event types for debugging
                this.outputChannel.appendLine(`[Query] Unhandled event type: ${event.type}`);
                break;
            }
          },
          requestHeaders
        );
      }

    } catch (error) {
      this.outputChannel.appendLine(`[Query] Error: ${error}`);
      this._view.webview.postMessage({
        command: 'streamError',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get current git branch for the workspace
   */
  private async getCurrentGitBranch(workspacePath: string): Promise<string> {
    try {
      // First try to get from indexing manager if available
      if (this.indexingManager && this.isIndexingReady) {
        const status = this.indexingManager.getStatus();
        if (status.gitBranch && status.gitBranch !== 'default') {
          return status.gitBranch;
        }
      }

      // Fallback to direct git command
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspacePath
      });
      return stdout.trim() || 'default';
    } catch (error) {
      // No git repository or other error
      this.outputChannel.appendLine(`[GitBranch] Failed to get git branch: ${error}`);
      return 'default';
    }
  }

  /**
   * Parse @ mentions from user query including file attachments
   */
  private parseContextMentions(query: string): string[] {
    const mentions: string[] = [];
    const atMentionRegex = /@([^\s]+)/g;
    let match;

    while ((match = atMentionRegex.exec(query)) !== null) {
      const mention = match[1].toLowerCase();

      // Map user-friendly names to actual context types
      if (mention === 'problems' || mention === 'problem') {
        mentions.push('problems');
      } else if (mention === 'project' || mention === 'structure') {
        mentions.push('project-structure');
      } else if (mention === 'git') {
        mentions.push('git');
      } else if (mention === 'files' || mention === 'open') {
        mentions.push('open-files');
      } else {
        // Check if it's a file path
        const originalMention = match[1]; // Keep original case
        if (originalMention.includes('.') || originalMention.includes('/')) {
          // This looks like a file path, add it as a file mention
          mentions.push(`file:${originalMention}`);
        }
      }
    }

    return mentions;
  }



  /**
   * Handle on-demand context requests from backend
   */
  private async handleContextRequest(contextType: string, params: any = {}) {
    if (!this.contextManager || !this._view) return;

    try {
      this.outputChannel.appendLine(`[ContextRequest] Handling request for: ${contextType}`);

      let result: any = null;

      switch (contextType) {
        case 'problems':
          if (params.filePath) {
            this.contextManager.setProblemsTargetFile(params.filePath);
          }
          result = await this.contextManager.collectContext({
            collectors: ['ProblemsCollector'],
            options: {
              includeFileContent: false,
              maxFileSize: 1048576,
              excludePatterns: [".venv/**", 'node_modules', '.git', 'dist', 'build'],
              includeHiddenFiles: false,
              respectGitignore: true,
              maxDepth: 10,
              parallel: false,
              useCache: true
            },
            timeout: 10000,
            retryCount: 1
          });
          break;

        case 'project-structure':
          result = await this.contextManager.collectContext({
            collectors: ['ProjectStructureCollector'],
            options: {
              includeFileContent: false,
              maxFileSize: 1048576,
              excludePatterns: [".venv/**", 'node_modules', '.git', 'dist', 'build'],
              includeHiddenFiles: false,
              respectGitignore: true,
              maxDepth: params.maxDepth || 6,
              parallel: false,
              useCache: true // Project structure should be cached and re-cached on file changes
            },
            timeout: 15000,
            retryCount: 1
          });
          break;

        case 'git':
          result = await this.contextManager.collectContext({
            collectors: ['GitContextCollector'],
            options: {
              includeFileContent: params.includeChanges !== false,
              maxFileSize: 1048576,
              excludePatterns: [".venv/**", 'node_modules', '.git', 'dist', 'build'],
              includeHiddenFiles: false,
              respectGitignore: true,
              maxDepth: 10,
              parallel: false,
              useCache: false // Never cache git context
            },
            timeout: 15000,
            retryCount: 1
          });
          break;

        case 'open-files':
          result = await this.contextManager.collectContext({
            collectors: ['OpenFilesCollector'],
            options: {
              includeFileContent: params.includeContent === true,
              maxFileSize: 1048576,
              excludePatterns: [".venv/**", 'node_modules', '.git', 'dist', 'build'],
              includeHiddenFiles: false,
              respectGitignore: true,
              maxDepth: 10,
              parallel: false,
              useCache: false // Never cache open files context
            },
            timeout: 10000,
            retryCount: 1
          });
          break;

        default:
          this.outputChannel.appendLine(`[ContextRequest] Unknown context type: ${contextType}`);
          return;
      }

      if (result && result.success) {
        // Send context back to webview/backend
        this._view.webview.postMessage({
          command: 'contextResponse',
          contextType,
          data: result.context,
          success: true
        });
        this.outputChannel.appendLine(`[ContextRequest] Successfully provided ${contextType} context`);
      } else {
        this._view.webview.postMessage({
          command: 'contextResponse',
          contextType,
          error: 'Failed to collect context',
          success: false
        });
        this.outputChannel.appendLine(`[ContextRequest] Failed to collect ${contextType} context`);
      }

    } catch (error) {
      this.outputChannel.appendLine(`[ContextRequest] Error collecting ${contextType}: ${error}`);
      this._view.webview.postMessage({
        command: 'contextResponse',
        contextType,
        error: error instanceof Error ? error.message : String(error),
        success: false
      });
    }
  }

  /**
   * Get context summary for logging
   */
  private getContextSummary(context: ProcessedContext): string {
    return [
      `Workspace: ${context.workspace.path}`,
      `Current file: ${context.activeFile?.relativePath || 'none'}`,
      `Open files: ${context.openFiles.length}`,
      `Project structure: ${context.projectStructure.length > 0 ? 'Available' : 'Not available'}`,
      `Git branch: ${context.gitContext.branch || 'none'}`,
      `Git changes: ${context.gitContext.hasChanges ? 'yes' : 'no'}`,
      `Recent commits: ${context.gitContext.recentCommits.length}`,
      `Total tokens: ${context.totalTokens}`
    ].join('\n');
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
          permissionHandling: true,
          contextCollection: true,
          sqliteContextStorage: true
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


  private getEnhancedWebviewContent(webview: vscode.Webview): string {
    return getWebviewContent(webview, this._extensionUri);
  }

  /**
   * Refreshes the workspace context and sends it to the webview
   */
  public async refreshWorkspaceContext(): Promise<void> {
    try {
      if (!this.isContextManagerReady || !this.contextManager) {
        this.outputChannel.appendLine('[Context] Cannot refresh - context manager not ready');
        await this.initializeForWorkspace();

        if (!this.isContextManagerReady) {
          return;
        }
      }

      const collectionResult = await this.contextManager!.collectContext({
        options: {
          includeFileContent: true,
          maxFileSize: 1024 * 1024,
          excludePatterns: ['**/node_modules/**', '**/.git/**'],
          includeHiddenFiles: false,
          respectGitignore: true,
          maxDepth: 10,
          parallel: true,
          useCache: false // Force fresh collection
        }
      });

      if (!collectionResult.success || !collectionResult.context) {
        throw new Error('Failed to refresh workspace context');
      }

      const contextSummary = this.getContextSummary(collectionResult.context);
      this.outputChannel.appendLine(`[Context] Refreshed context:\n${contextSummary}`);

      if (this._view) {
        this._view.webview.postMessage({
          command: 'workspaceContextRefreshed',
          context: collectionResult.context,
          collectionResult: {
            success: collectionResult.success,
            duration: collectionResult.totalDuration,
            collectors: collectionResult.metadata.collectorCount,
            successCount: collectionResult.metadata.successCount
          }
        });
      }
    } catch (error) {
      this.outputChannel.appendLine(`[Context] Error refreshing context: ${error}`);
    }
  }


  /**
   * Manually trigger context collection
   */
  public async collectContextManually(): Promise<void> {
    try {
      if (!this.isContextManagerReady || !this.contextManager) {
        this.outputChannel.appendLine('[Context] Cannot collect - context manager not ready');
        await this.initializeForWorkspace();

        if (!this.isContextManagerReady) {
          if (this._view) {
            this._view.webview.postMessage({
              command: 'contextCollected',
              result: {
                success: false,
                error: 'Context manager not ready'
              },
              timestamp: Date.now()
            });
          }
          return;
        }
      }

      const collectionResult = await this.contextManager!.collectContext({
        options: {
          includeFileContent: true,
          maxFileSize: 1024 * 1024,
          excludePatterns: ['**/node_modules/**', '**/.git/**'],
          includeHiddenFiles: false,
          respectGitignore: true,
          maxDepth: 10,
          parallel: true,
          useCache: false
        }
      });

      if (this._view) {
        this._view.webview.postMessage({
          command: 'contextCollected',
          result: collectionResult,
          timestamp: Date.now()
        });
      }

      this.outputChannel.appendLine(
        `[Context] Manual collection completed: ${collectionResult.metadata.successCount}/${collectionResult.metadata.collectorCount} collectors successful`
      );
    } catch (error) {
      this.outputChannel.appendLine(`[Context] Manual collection failed: ${error}`);
    }
  }

  /**
   * Get current indexing status
   */
  private async getIndexingStatus(): Promise<void> {
    try {
      if (!this.indexingManager) {
        this._view?.webview.postMessage({
          command: 'indexingStatus',
          status: {
            isIndexed: false,
            workspaceHash: '',
            gitBranch: 'default',
            status: 'disabled'
          }
        });
        return;
      }

      const status = this.indexingManager.getStatus();
      this._view?.webview.postMessage({
        command: 'indexingStatus',
        status
      });

      this.outputChannel.appendLine(`[IndexingStatus] Status: ${status.status}, Indexed: ${status.isIndexed}`);

    } catch (error) {
      this.outputChannel.appendLine(`[IndexingStatus] Error: ${error}`);
      this._view?.webview.postMessage({
        command: 'indexingStatus',
        status: {
          isIndexed: false,
          workspaceHash: '',
          gitBranch: 'default',
          status: 'error'
        }
      });
    }
  }

  /**
   * Manually trigger indexing
   */
  private async triggerIndexingManually(): Promise<void> {
    try {
      if (!this.indexingManager) {
        this._view?.webview.postMessage({
          command: 'indexingTriggerResult',
          success: false,
          error: 'Indexing manager not available'
        });
        return;
      }

      this.outputChannel.appendLine('[IndexingTrigger] Manual indexing triggered');
      await this.indexingManager.triggerIndexing();

      this._view?.webview.postMessage({
        command: 'indexingTriggerResult',
        success: true
      });

      this.outputChannel.appendLine('[IndexingTrigger] Manual indexing completed');

    } catch (error) {
      this.outputChannel.appendLine(`[IndexingTrigger] Error: ${error}`);
      this._view?.webview.postMessage({
        command: 'indexingTriggerResult',
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get available files for context attachment
   */
  private async getAvailableFiles(): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this._view?.webview.postMessage({
          command: 'availableFiles',
          files: []
        });
        return;
      }

      // Use glob to find files, excluding common non-useful directories
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**,**/coverage/**,**/*.log}',
        1000 // Limit to 1000 files for performance
      );

      const relativePaths = files
        .map(file => vscode.workspace.asRelativePath(file))
        .filter(path => {
          // Filter out very long paths and certain file types
          return path.length < 100 &&
            !path.includes('node_modules') &&
            !path.includes('.git/') &&
            !path.startsWith('.') &&
            !path.endsWith('.lock') &&
            !path.endsWith('.log');
        })
        .sort();

      this._view?.webview.postMessage({
        command: 'availableFiles',
        files: relativePaths
      });

      this.outputChannel.appendLine(`[AvailableFiles] Found ${relativePaths.length} files`);

    } catch (error) {
      this.outputChannel.appendLine(`[AvailableFiles] Error: ${error}`);
      this._view?.webview.postMessage({
        command: 'availableFiles',
        files: []
      });
    }
  }

  /**
   * Clean up all resources
   */
  public async cleanup(): Promise<void> {
    try {
      this.outputChannel.appendLine('[Extension] Starting cleanup...');

      // Cleanup enhanced streaming client
      if (this.enhancedStreamingClient) {
        this.outputChannel.appendLine('[Extension] Cleaning up streaming client...');
        this.enhancedStreamingClient.resetCurrentState();
      }

      // Cleanup context API server
      if (this.contextApiServer) {
        this.outputChannel.appendLine('[Extension] Stopping context API server...');
        await this.contextApiServer.stop();
        this.contextApiServer.dispose();
        this.contextApiServer = null;
      }

      // Cleanup indexing manager
      if (this.indexingManager) {
        this.outputChannel.appendLine('[Extension] Disposing indexing manager...');
        await this.indexingManager.dispose();
        this.indexingManager = null;
        this.isIndexingReady = false;
      }

      // Cleanup context manager
      if (this.contextManager) {
        this.outputChannel.appendLine('[Extension] Disposing context manager...');
        this.contextManager.dispose();
        this.contextManager = null;
        this.isContextManagerReady = false;
      }

      // Cleanup workspace event listeners
      for (const disposable of this.workspaceDisposables) {
        disposable.dispose();
      }
      this.workspaceDisposables = [];

      this.outputChannel.appendLine('[Extension] Cleanup completed');

    } catch (error) {
      this.outputChannel.appendLine(`[Extension] Error during cleanup: ${error}`);
    }
  }

  private updateStatusBar() {
    const contextStatus = this.isContextManagerReady ? 'Context' : '';
    const indexingStatus = this.isIndexingReady ? 'Indexing' : '';

    const features = [contextStatus, indexingStatus].filter(Boolean);

    if (features.length > 0) {
      this.statusBarItem.text = `$(plug) Enhanced Agent Server (TRUE Streaming + ${features.join(' + ')})`;
      this.statusBarItem.tooltip = `Enhanced Agent Server Status (TRUE Streaming + ${features.join(' + ')})`;
    } else {
      this.statusBarItem.text = '$(plug) Enhanced Agent Server';
      this.statusBarItem.tooltip = 'Enhanced Agent Server Status (Original)';
    }

    // Add indexing status information if available
    if (this.indexingManager && this.isIndexingReady) {
      const status = this.indexingManager.getStatus();
      if (status.isIndexed && status.lastIndexTime) {
        const lastIndexed = new Date(status.lastIndexTime).toLocaleTimeString();
        this.statusBarItem.tooltip += `\nCodebase indexed at ${lastIndexed}`;
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Enhanced Assistant');
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(rocket) Enhanced Assistant';
  statusBarItem.tooltip = 'Enhanced Assistant Status';
  statusBarItem.show();

  outputChannel.appendLine('[Extension] Activating Enhanced Assistant extension...');

  // Create the view provider
  const provider = new EnhancedAssistantViewProvider(
    context.extensionUri,
    context,
    outputChannel,
    statusBarItem
  );

  // Register the provider
  const view = vscode.window.registerWebviewViewProvider(
    EnhancedAssistantViewProvider.viewType,
    provider
  );

  context.subscriptions.push(view);
  context.subscriptions.push(statusBarItem);

  // Register commands
  const refreshCommand = vscode.commands.registerCommand('enhancedAssistant.refresh', () => {
    provider.refreshEnhancedStreamingConnection();
  });

  const collectContextCommand = vscode.commands.registerCommand('enhancedAssistant.collectContext', () => {
    provider.collectContextManually();
  });

  const refreshWorkspaceCommand = vscode.commands.registerCommand('enhancedAssistant.refreshWorkspace', () => {
    provider.refreshWorkspaceContext();
  });

  context.subscriptions.push(refreshCommand, collectContextCommand, refreshWorkspaceCommand);

  outputChannel.appendLine('[Extension] Enhanced Assistant extension activated');
}

export function deactivate() {
  // Clean up any resources here
} 