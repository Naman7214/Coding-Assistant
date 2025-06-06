import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextApiServer } from './api/ContextApiServer';
import { ContextManager } from './context/ContextManager';
import { ProcessedContext } from './context/types/context';
import { EnhancedStreamingClient } from './enhanced_streaming_client';
import { getSystemInfo, getWebviewContent } from './utilities';

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
  private isContextManagerReady = false;
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

      // Initialize the context manager with safe defaults
      this.contextManager = new ContextManager(this.context, this.outputChannel, {
        enabled: true,
        autoCollectOnChange: false, // Disable auto-collect initially
        autoCollectInterval: 30000,
        defaultCollectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector', 'ProblemsCollector'],
        storageConfig: {
          enableStorage: true,
          enableCache: true
        }
      });

      this.outputChannel.appendLine('[Extension] Initializing context manager...');
      await this.contextManager.initialize();

      // Create and start API server
      this.outputChannel.appendLine('[Extension] Creating Context API server...');
      this.contextApiServer = new ContextApiServer(
        this.contextManager.getStorage(),
        this.contextManager,
        this.outputChannel
      );

      this.outputChannel.appendLine('[Extension] Starting Context API server...');
      await this.contextApiServer.start();

      this.isContextManagerReady = true;
      this.outputChannel.appendLine('[Extension] Context manager and API server ready');

      // Set up event listeners now that context manager is ready
      this.setupContextManagerEventListeners();

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
   * Setup workspace watcher for delayed initialization
   */
  private setupWorkspaceWatcher(): void {
    // Watch for workspace folder changes
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      if (event.added.length > 0 && !this.isContextManagerReady) {
        this.outputChannel.appendLine('[Extension] Workspace folder added - initializing context manager...');
        await this.createAndInitializeContextManager();
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
        await this.handleSimpleQuery(message.text);
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

      case 'refreshContext':
        await this.refreshWorkspaceContext();
        return;

      case 'exportContext':
        await this.exportWorkspaceContext();
        return;

      case 'collectContext':
        await this.collectContextManually();
        return;

      case 'initializeWorkspace':
        await this.initializeForWorkspace();
        return;

      case 'handleSimpleQuery':
        await this.handleSimpleQuery(message.query);
        return;

      case 'handleContextRequest':
        await this.handleContextRequest(message.contextType, message.params);
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

  // public async handleEnhancedQuery(query: string, useStreaming: boolean = true) {
  //   if (!this._view) return;

  //   try {
  //     // Check workspace first
  //     const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
  //     if (!hasWorkspace) {
  //       this.updateResponse('❌ No workspace is open. Please open a folder to enable workspace analysis.');
  //       vscode.window.showErrorMessage(
  //         'No workspace folder is open. Please open a folder first.',
  //         'Open Folder'
  //       ).then(selection => {
  //         if (selection === 'Open Folder') {
  //           vscode.commands.executeCommand('vscode.openFolder');
  //         }
  //       });
  //       return;
  //     }

  //     // Initialize context manager if not ready
  //     if (!this.isContextManagerReady) {
  //       this.outputChannel.appendLine('[Context] Context manager not ready - attempting initialization...');
  //       this.updateResponse('🔄 Initializing context manager for workspace analysis...');

  //       await this.initializeForWorkspace();

  //       if (!this.isContextManagerReady) {
  //         this.updateResponse('❌ Failed to initialize context manager. Please check the output for details.');
  //         return;
  //       }

  //       this.outputChannel.appendLine('[Context] Context manager is now ready');
  //     }

  //     // Collect workspace context
  //     this.outputChannel.appendLine('[Context] Collecting comprehensive workspace context...');
  //     this.updateResponse('🔍 Analyzing workspace structure and context...');

  //     const collectionResult = await this.contextManager!.collectContext({
  //       collectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector', 'ProblemsCollector'],
  //       options: {
  //         includeFileContent: true,
  //         maxFileSize: 1024 * 1024, // 1MB
  //         excludePatterns: ['**/node_modules/**', '**/.git/**'],
  //         includeHiddenFiles: false,
  //         respectGitignore: true,
  //         maxDepth: 10,
  //         parallel: true,
  //         useCache: true
  //       }
  //     });

  //     if (!collectionResult.success || !collectionResult.context) {
  //       this.updateResponse('❌ Failed to collect workspace context. Please check the output for details.');
  //       return;
  //     }

  //     const fullContext = collectionResult.context;

  //     this.outputChannel.appendLine(`[Context] Full Workspace Context:\n${JSON.stringify(fullContext, null, 2)}`);

  //     // Send context to webview for display
  //     if (this._view) {
  //       this._view.webview.postMessage({
  //         command: 'workspaceContext',
  //         context: fullContext,
  //         collectionResult: {
  //           success: collectionResult.success,
  //           duration: collectionResult.totalDuration,
  //           collectors: collectionResult.metadata.collectorCount,
  //           successCount: collectionResult.metadata.successCount
  //         }
  //       });
  //     }

  //     if (useStreaming && this.enhancedStreamingClient) {
  //       // Use streaming API with workspace context
  //       this.outputChannel.appendLine(`🚀 Using enhanced streaming API for query: ${query}`);
  //       this.updateResponse('🧠 Processing your query with AI agent...');

  //       const streamRequest: any = {
  //         query: query,
  //         workspace_path: fullContext.workspace.path
  //       };

  //       // Prepare headers with workspace ID
  //       const requestHeaders = {
  //         'X-Workspace-ID': this.contextManager!.getWorkspaceId()
  //       };

  //       // Stream the query
  //       await this.enhancedStreamingClient.streamQuery(
  //         streamRequest,
  //         this._view.webview,
  //         async (event, state) => {
  //           // Enhanced event handling
  //           this.outputChannel.appendLine(`[EVENT] ${event.type}: ${event.content.substring(0, 50)}...`);

  //           if (event.type === 'thinking' && event.content.length > 100) {
  //             this.statusBarItem.text = `🧠 Thinking... (${event.content.length} chars)`;
  //           } else if (event.type === 'tool_selection') {
  //             this.outputChannel.appendLine(`🔧 TOOL SELECTED: ${event.metadata?.tool_name}`);
  //           } else if (event.type === 'final_response') {
  //             this.outputChannel.appendLine('✅ Enhanced streaming query completed');
  //             this.statusBarItem.text = '$(plug) Agent Server (Enhanced)';
  //           }
  //         },
  //         requestHeaders
  //       );
  //     }

  //   } catch (error) {
  //     console.error('Error processing enhanced query:', error);
  //     const errorMessage = `❌ Error: ${error instanceof Error ? error.message : String(error)}`;
  //     this.updateResponse(errorMessage);
  //     this.outputChannel.appendLine(`Enhanced query error: ${errorMessage}`);
  //   }
  // }

  /**
   * Handle queries from the simplified UI
   */
  public async handleSimpleQuery(query: string) {
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
      this.outputChannel.appendLine(`[SimpleQuery] Detected context mentions: ${JSON.stringify(contextMentions)}`);

      // Collect always-send context (system info + active file)
      const alwaysSendContext = await this.collectAlwaysSendContext();

      // Send query with always-send context to backend
      if (this.enhancedStreamingClient) {
        const streamRequest: any = {
          query: query,
          workspace_path: alwaysSendContext.workspace.path,
          system_info: alwaysSendContext.systemInfo,
          active_file_context: alwaysSendContext.activeFile,
          context_mentions: contextMentions
        };

        const requestHeaders = {
          'X-Workspace-ID': this.contextManager!.getWorkspaceId()
        };

        // DEBUG: Log the exact request being sent with detailed structure analysis
        this.outputChannel.appendLine(`[SimpleQuery] DEBUG - Request payload structure analysis:`);
        this.outputChannel.appendLine(`Query: "${streamRequest.query}"`);
        this.outputChannel.appendLine(`Workspace Path: "${streamRequest.workspace_path}"`);
        this.outputChannel.appendLine(`System Info Fields: [${Object.keys(streamRequest.system_info || {}).join(', ')}]`);
        this.outputChannel.appendLine(`System Info: ${JSON.stringify(streamRequest.system_info, null, 2)}`);

        if (streamRequest.active_file_context) {
          this.outputChannel.appendLine(`Active File Context Fields: [${Object.keys(streamRequest.active_file_context).join(', ')}]`);
          this.outputChannel.appendLine(`Active File Context: ${JSON.stringify(streamRequest.active_file_context, null, 2)}`);
        } else {
          this.outputChannel.appendLine(`Active File Context: null`);
        }

        this.outputChannel.appendLine(`Context Mentions: ${JSON.stringify(streamRequest.context_mentions)}`);
        this.outputChannel.appendLine(`Headers: ${JSON.stringify(requestHeaders)}`);
        this.outputChannel.appendLine(`[SimpleQuery] DEBUG - Expected Python model comparison:`);
        this.outputChannel.appendLine(`Expected SystemInfo fields: platform, osVersion, architecture, workspacePath, defaultShell`);
        this.outputChannel.appendLine(`Expected ActiveFileContext fields: path, relativePath, languageId, lineCount, fileSize, lastModified, content, cursorPosition, selection, visibleRanges, cursorLineContent`);
        this.outputChannel.appendLine(`[SimpleQuery] DEBUG - Sending request to ${this.enhancedStreamingClient['baseUrl']}/stream`);

        // Stream the query with comprehensive event handling for SimpleApp
        await this.enhancedStreamingClient.streamQuery(
          streamRequest,
          this._view.webview,
          async (event, state) => {
            // Comprehensive event handling for the SimpleApp UI
            switch (event.type) {
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

              case 'assistant_response':
                this._view!.webview.postMessage({
                  command: 'responseUpdate',
                  content: event.content
                });
                break;

              case 'thinking':
                // Forward thinking events to UI for transparency
                this._view!.webview.postMessage({
                  command: 'thinking',
                  content: event.content,
                  metadata: event.metadata
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

              default:
                // Log unhandled event types for debugging
                this.outputChannel.appendLine(`[SimpleQuery] Unhandled event type: ${event.type}`);
                break;
            }
          },
          requestHeaders
        );
      }

    } catch (error) {
      this.outputChannel.appendLine(`[SimpleQuery] Error: ${error}`);
      this._view.webview.postMessage({
        command: 'streamError',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Parse @ mentions from user query
   */
  private parseContextMentions(query: string): string[] {
    const mentions: string[] = [];
    const atMentionRegex = /@(\w+)/g;
    let match;

    while ((match = atMentionRegex.exec(query)) !== null) {
      const mention = match[1].toLowerCase();

      // Map user-friendly names to actual context types
      switch (mention) {
        case 'problems':
          mentions.push('problems');
          break;
        case 'project':
        case 'structure':
          mentions.push('project-structure');
          break;
        case 'git':
          mentions.push('git');
          break;
        case 'files':
        case 'open':
          mentions.push('open-files');
          break;
      }
    }

    return mentions;
  }

  /**
   * Collect always-send context (system info + active file)
   */
  private async collectAlwaysSendContext(): Promise<any> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // Get system info using the utility function that matches Python model
    const systemInfo = await getSystemInfo();

    // Collect active file context and transform to match Python ActiveFileContext model
    let activeFileContext: any = null;
    if (this.contextManager) {
      try {
        const activeFileResult = await this.contextManager.collectContext({
          collectors: ['ActiveFileCollector'],
          options: {
            includeFileContent: true,
            maxFileSize: 1048576,
            excludePatterns: ['node_modules', '.git', 'dist', 'build'],
            includeHiddenFiles: false,
            respectGitignore: true,
            maxDepth: 10,
            parallel: false,
            useCache: true
          },
          timeout: 5000,
          retryCount: 1
        });

        if (activeFileResult.success && activeFileResult.context) {
          const activeFile = activeFileResult.context.activeFile;

          if (activeFile) {
            // Transform to match Python ActiveFileContext model exactly
            activeFileContext = {
              path: activeFile.path || null,
              relativePath: activeFile.relativePath || null,
              languageId: activeFile.languageId || null,
              lineCount: activeFile.lineCount || null,
              fileSize: activeFile.fileSize || null,
              lastModified: activeFile.lastModified || null,
              content: null, // Don't send content for now to reduce size
              cursorPosition: activeFile.cursorPosition ? {
                line: activeFile.cursorPosition.line,
                character: activeFile.cursorPosition.character
              } : null,
              selection: activeFile.selection ? {
                start: {
                  line: activeFile.selection.start.line,
                  character: activeFile.selection.start.character
                },
                end: {
                  line: activeFile.selection.end.line,
                  character: activeFile.selection.end.character
                }
              } : null,
              visibleRanges: activeFile.visibleRanges ? activeFile.visibleRanges.map((range: any) => ({
                start: { line: range.start.line, character: range.start.character },
                end: { line: range.end.line, character: range.end.character }
              })) : null,
              cursorLineContent: activeFile.cursorLineContent || null
            };
          }
        }
      } catch (error) {
        this.outputChannel.appendLine(`[AlwaysSendContext] Failed to collect active file: ${error}`);
      }
    }

    return {
      systemInfo,
      activeFile: activeFileContext,
      workspace: {
        path: workspaceFolder?.uri.fsPath || '',
        name: workspaceFolder?.name || ''
      }
    };
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
              excludePatterns: ['node_modules', '.git', 'dist', 'build'],
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
              excludePatterns: ['node_modules', '.git', 'dist', 'build'],
              includeHiddenFiles: false,
              respectGitignore: true,
              maxDepth: params.maxDepth || 6,
              parallel: false,
              useCache: true
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
              excludePatterns: ['node_modules', '.git', 'dist', 'build'],
              includeHiddenFiles: false,
              respectGitignore: true,
              maxDepth: 10,
              parallel: false,
              useCache: true
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
              excludePatterns: ['node_modules', '.git', 'dist', 'build'],
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

      const currentState = this.enhancedStreamingClient?.getCurrentState();
      const contextStats = this.contextManager?.getStats();

      const logContent = [
        '=== ENHANCED STREAMING LOGS ===',
        `Timestamp: ${new Date().toLocaleString()}`,
        `Streaming API URL: ${STREAMING_API_URL}`,
        `Workspace ID: ${this.contextManager?.getWorkspaceId() || 'N/A'}`,
        `Context Manager Ready: ${this.isContextManagerReady}`,
        '',
        '=== CURRENT STATE ===',
        JSON.stringify(currentState, null, 2),
        '',
        '=== CONTEXT MANAGER STATS ===',
        JSON.stringify(contextStats, null, 2),
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

  private getEnhancedWebviewContent(webview: vscode.Webview): string {
    return getWebviewContent(webview, this._extensionUri);
  }

  /**
   * Refreshes the workspace context and sends it to the webview
   */
  private async refreshWorkspaceContext() {
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
   * Exports the current workspace context to a file
   */
  private async exportWorkspaceContext() {
    try {
      if (!this.isContextManagerReady || !this.contextManager) {
        vscode.window.showErrorMessage('Context manager is not ready yet. Please wait for initialization to complete.');
        return;
      }

      const collectionResult = await this.contextManager!.collectContext();
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found for exporting context');
        return;
      }

      if (!collectionResult.success || !collectionResult.context) {
        throw new Error('Failed to collect workspace context for export');
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const contextFileName = `workspace-context-${timestamp}.json`;
      const contextFilePath = path.join(workspaceFolder.uri.fsPath, contextFileName);

      const exportContext = {
        ...collectionResult.context,
        activeFile: collectionResult.context.activeFile ? {
          ...collectionResult.context.activeFile,
          content: `[Content Length: ${collectionResult.context.activeFile.content?.length || 0} characters]`
        } : null,
        collectionMetadata: {
          timestamp: collectionResult.metadata.timestamp,
          duration: collectionResult.totalDuration,
          collectors: collectionResult.metadata.collectorCount,
          successCount: collectionResult.metadata.successCount,
          errors: collectionResult.errors,
          workspaceId: this.contextManager!.getWorkspaceId()
        }
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

  /**
   * Manually trigger context collection
   */
  private async collectContextManually() {
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
    if (this.isContextManagerReady) {
      this.statusBarItem.text = '$(plug) Enhanced Agent Server (TRUE Streaming + Context Collection)';
      this.statusBarItem.tooltip = 'Enhanced Agent Server Status (TRUE Streaming + Context Collection)';
    } else {
      this.statusBarItem.text = '$(plug) Enhanced Agent Server';
      this.statusBarItem.tooltip = 'Enhanced Agent Server Status (Original)';
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Enhanced Assistant Sidebar extension with improved workspace handling');

  const outputChannel = vscode.window.createOutputChannel('Enhanced Agent Assistant');
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(plug) Enhanced Agent Server';
  statusBarItem.tooltip = 'Enhanced Agent Server Status (TRUE Streaming + Context Collection)';
  statusBarItem.command = 'enhanced-assistant-sidebar.refreshConnection';
  statusBarItem.show();

  const provider = new EnhancedAssistantViewProvider(context.extensionUri, context, outputChannel, statusBarItem);

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
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
          vscode.window.showErrorMessage('No workspace folder is open. Please open a folder first.');
          return;
        }

        outputChannel.appendLine(`[SERVER] Starting streaming server from workspace: ${workspacePath}`);

        const terminal = vscode.window.createTerminal('Enhanced Streaming Agent Server');
        terminal.sendText(`cd "${workspacePath}"`);
        terminal.sendText(`echo "Starting streaming server from: $(pwd)"`);
        terminal.sendText(`python3 system/coding_agent/agent_streaming_api.py`);
        terminal.show();

        outputChannel.appendLine(`[SERVER] Terminal commands sent to start server from ${workspacePath}`);
        vscode.window.showInformationMessage('Enhanced TRUE streaming agent server started from workspace');

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

      // if (query) {
      //   await provider.handleEnhancedQuery(query, true);
      // }
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.collectContext', async () => {
      outputChannel.appendLine('[COMMAND] Manually collecting workspace context...');
      vscode.window.showInformationMessage('Context collection initiated');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.clearState', async () => {
      outputChannel.appendLine('[COMMAND] Clearing enhanced streaming state...');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.exportLogs', async () => {
      outputChannel.appendLine('[COMMAND] Exporting enhanced streaming logs...');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.refreshContext', async () => {
      outputChannel.appendLine('[COMMAND] Refreshing workspace context...');
      vscode.window.showInformationMessage('Workspace context refresh initiated');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.exportContext', async () => {
      outputChannel.appendLine('[COMMAND] Exporting workspace context...');
      vscode.window.showInformationMessage('Workspace context export initiated');
    }),

    vscode.commands.registerCommand('enhanced-assistant-sidebar.openWorkspace', async () => {
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

  context.subscriptions.push({
    dispose: async () => {
      await provider.cleanup();
    }
  });

  context.subscriptions.push(outputChannel, statusBarItem);

  console.log('Enhanced Assistant Sidebar extension activated with robust workspace handling');
}

export function deactivate() {
  // Clean up any resources here
} 