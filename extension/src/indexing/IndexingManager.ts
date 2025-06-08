import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { IndexingOrchestrator } from './core/indexing-orchestrator';
import { ServerCommunication, createServerCommunicationFromSettings } from './core/server-communication';
import { CodeChunk, IndexingStats } from './types/chunk';
import { hashWorkspacePath } from './utils/hash';

export interface IndexingManagerConfig {
    enabled: boolean;
    indexingInterval: number; // 10 minutes in milliseconds
    maxFileSize: number;
    excludePatterns: string[];
    serverUrl: string;
    apiKey?: string;
}

export interface IndexingStatusInfo {
    isIndexed: boolean;
    lastIndexTime?: number;
    totalChunks?: number;
    workspaceHash: string;
    gitBranch: string;
    status: 'idle' | 'indexing' | 'error' | 'disabled';
}

export class IndexingManager extends EventEmitter {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private config: IndexingManagerConfig;
    private orchestrator: IndexingOrchestrator | null = null;
    private serverCommunication: ServerCommunication | null = null;
    private workspacePath: string = '';
    private workspaceHash: string = '';
    private currentGitBranch: string = 'default';
    private indexingTimer: NodeJS.Timeout | null = null;
    private isInitialized: boolean = false;
    private isIndexing: boolean = false;
    private statusInfo: IndexingStatusInfo;
    private disposables: vscode.Disposable[] = [];

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        config?: Partial<IndexingManagerConfig>
    ) {
        super();
        this.context = context;
        this.outputChannel = outputChannel;

        // Default configuration
        this.config = {
            enabled: true,
            indexingInterval: 10 * 60 * 1000, // 10 minutes
            maxFileSize: 1 * 1024 * 1024, // 1MB
            excludePatterns: [".venv/**", 'node_modules/**', '.git/**', 'dist/**', 'build/**', '**/*.log'],
            serverUrl: 'http://localhost:8000',
            apiKey: undefined,
            ...config
        };

        // Initialize status
        this.statusInfo = {
            isIndexed: false,
            workspaceHash: '',
            gitBranch: 'default',
            status: 'idle'
        };

        this.outputChannel.appendLine('[IndexingManager] Initialized with configuration');
    }

    /**
     * Initialize indexing for the current workspace
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            this.outputChannel.appendLine('[IndexingManager] Already initialized');
            return;
        }

        try {
            this.outputChannel.appendLine('[IndexingManager] Starting initialization...');

            // Get workspace information
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.outputChannel.appendLine('[IndexingManager] No workspace folder found - indexing disabled');
                this.statusInfo.status = 'disabled';
                this.isInitialized = true;
                this.emit('statusChanged', this.statusInfo);
                return;
            }

            this.workspacePath = workspaceFolder.uri.fsPath;
            this.workspaceHash = hashWorkspacePath(this.workspacePath);

            this.outputChannel.appendLine(`[IndexingManager] Workspace: ${workspaceFolder.name}`);
            this.outputChannel.appendLine(`[IndexingManager] Workspace hash: ${this.workspaceHash}`);

            // Initialize orchestrator
            this.orchestrator = new IndexingOrchestrator(this.context, this.workspacePath, this.outputChannel);
            await this.orchestrator.initialize();

            // Get initial git branch from orchestrator
            this.currentGitBranch = this.orchestrator.getCurrentBranch();

            // Initialize server communication
            this.serverCommunication = createServerCommunicationFromSettings(this.workspaceHash);
            this.outputChannel.appendLine(`[IndexingManager] Server communication initialized: ${this.serverCommunication.getConfig().baseUrl}`);

            // Set up event listeners
            this.setupEventListeners();

            // Perform initial indexing
            await this.performInitialIndexing();

            // Start periodic indexing
            this.startPeriodicIndexing();

            // Set up workspace change watcher
            this.setupWorkspaceWatcher();

            this.isInitialized = true;
            this.statusInfo.status = 'idle';
            this.statusInfo.workspaceHash = this.workspaceHash;
            this.statusInfo.gitBranch = this.currentGitBranch;

            this.outputChannel.appendLine('[IndexingManager] Successfully initialized');
            this.emit('initialized', { workspaceHash: this.workspaceHash, gitBranch: this.currentGitBranch });
            this.emit('statusChanged', this.statusInfo);

        } catch (error) {
            this.outputChannel.appendLine(`[IndexingManager] Failed to initialize: ${error}`);
            this.statusInfo.status = 'error';
            this.emit('statusChanged', this.statusInfo);
            throw error;
        }
    }

    /**
     * Perform initial indexing when workspace loads
     */
    private async performInitialIndexing(): Promise<void> {
        if (!this.orchestrator) {
            throw new Error('Orchestrator not initialized');
        }

        try {
            this.outputChannel.appendLine('[IndexingManager] Starting initial indexing...');
            this.isIndexing = true;
            this.statusInfo.status = 'indexing';
            this.emit('statusChanged', this.statusInfo);

            // Check if workspace was indexed before
            const existingStats = await this.orchestrator.getIndexingStats();

            if (existingStats && existingStats.lastIndexTime > 0) {
                this.outputChannel.appendLine('[IndexingManager] Previous indexing found - letting orchestrator handle change detection');
            } else {
                this.outputChannel.appendLine('[IndexingManager] First time indexing workspace');
            }

            // Trigger indexing - orchestrator will handle change detection and chunk generation
            this.outputChannel.appendLine('[IndexingManager] Triggering initial indexing...');
            await this.orchestrator.triggerIndexing();

            // Update status - chunks will be handled by the callback in setupEventListeners
            this.statusInfo.isIndexed = true;
            this.statusInfo.lastIndexTime = Date.now();
            this.outputChannel.appendLine('[IndexingManager] Initial indexing triggered successfully');

            this.isIndexing = false;
            this.statusInfo.status = 'idle';
            this.emit('statusChanged', this.statusInfo);
            this.emit('indexingCompleted', {
                chunks: 0, // Will be updated by callback when chunks are received
                timestamp: Date.now()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[IndexingManager] Initial indexing failed: ${error}`);
            this.isIndexing = false;
            this.statusInfo.status = 'error';
            this.emit('statusChanged', this.statusInfo);
            throw error;
        }
    }

    /**
     * Start periodic indexing (every 10 minutes)
     */
    private startPeriodicIndexing(): void {
        if (this.indexingTimer) {
            clearInterval(this.indexingTimer);
        }

        this.indexingTimer = setInterval(async () => {
            if (!this.isIndexing && this.config.enabled) {
                try {
                    await this.performPeriodicIndexing();
                } catch (error) {
                    this.outputChannel.appendLine(`[IndexingManager] Periodic indexing failed: ${error}`);
                }
            }
        }, this.config.indexingInterval);

        this.outputChannel.appendLine(`[IndexingManager] Started periodic indexing (${this.config.indexingInterval / 1000}s interval)`);
    }

    /**
     * Perform periodic indexing check
     */
    private async performPeriodicIndexing(): Promise<void> {
        if (!this.orchestrator) {
            return;
        }

        try {
            this.outputChannel.appendLine('[IndexingManager] Starting periodic indexing - orchestrator will handle change detection');
            this.isIndexing = true;
            this.statusInfo.status = 'indexing';
            this.emit('statusChanged', this.statusInfo);

            // Trigger periodic indexing - orchestrator will handle change detection and chunk generation
            await this.orchestrator.triggerIndexing();

            // Update status - chunks will be handled by the callback in setupEventListeners
            this.statusInfo.lastIndexTime = Date.now();
            this.outputChannel.appendLine('[IndexingManager] Periodic indexing triggered successfully');

            this.emit('indexingCompleted', {
                chunks: 0, // Will be updated by callback when chunks are received
                timestamp: Date.now()
            });

            this.isIndexing = false;
            this.statusInfo.status = 'idle';
            this.emit('statusChanged', this.statusInfo);

        } catch (error) {
            this.outputChannel.appendLine(`[IndexingManager] Periodic indexing error: ${error}`);
            this.isIndexing = false;
            this.statusInfo.status = 'error';
            this.emit('statusChanged', this.statusInfo);
        }
    }

    /**
     * Set up event listeners for git and file changes
     */
    private setupEventListeners(): void {
        if (!this.orchestrator) {
            return;
        }

        // Listen for branch changes from orchestrator
        this.orchestrator.onBranchChange((newBranch: string, oldBranch: string) => {
            this.outputChannel.appendLine(`[IndexingManager] Git branch changed: ${oldBranch} → ${newBranch}`);
            this.currentGitBranch = newBranch;
            this.statusInfo.gitBranch = newBranch;

            this.outputChannel.appendLine('[IndexingManager] Branch change handled by orchestrator with branch-specific merkle trees');
            this.emit('statusChanged', this.statusInfo);
        });

        // Set up orchestrator callbacks
        if (this.orchestrator) {
            // Set up single callback to handle chunks and send to server
            this.orchestrator.onChunksReady(async (chunks: CodeChunk[], deletedFiles: string[]) => {
                this.outputChannel.appendLine(`[IndexingManager] Received ${chunks.length} chunks and ${deletedFiles.length} deleted files from orchestrator`);

                // Update status
                this.statusInfo.totalChunks = (this.statusInfo.totalChunks || 0) + chunks.length;
                this.statusInfo.lastIndexTime = Date.now();

                // Send chunks and deleted files to server
                if (this.serverCommunication && (chunks.length > 0 || deletedFiles.length > 0)) {
                    try {
                        this.outputChannel.appendLine(`[IndexingManager] Sending ${chunks.length} chunks and ${deletedFiles.length} deleted files to server...`);
                        const response = await this.serverCommunication.sendChunksToServer(chunks, deletedFiles, this.currentGitBranch);
                        this.outputChannel.appendLine(`[IndexingManager] Server response: processed=${response.processedChunks}, skipped=${response.skippedChunks}`);
                    } catch (error) {
                        this.outputChannel.appendLine(`[IndexingManager] Failed to send chunks to server: ${error}`);
                    }
                }

                // Emit for UI updates
                this.emit('chunksProcessed', chunks);
                this.emit('indexingCompleted', {
                    chunks: chunks.length,
                    timestamp: Date.now()
                });
            });

            // Note: IndexingOrchestrator doesn't have error events, 
            // errors will be handled through try/catch in method calls
        }
    }

    /**
     * Set up workspace folder change watcher
     */
    private setupWorkspaceWatcher(): void {
        const disposable = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            if (event.added.length > 0 || event.removed.length > 0) {
                this.outputChannel.appendLine('[IndexingManager] Workspace folders changed - reinitializing');

                // Dispose current state
                await this.dispose();

                // Reinitialize for new workspace
                await this.initialize();
            }
        });

        this.disposables.push(disposable);
    }

    /**
     * Get current indexing status
     */
    getStatus(): IndexingStatusInfo {
        return { ...this.statusInfo };
    }

    /**
     * Check if workspace is currently indexed
     */
    isWorkspaceIndexed(): boolean {
        return this.statusInfo.isIndexed;
    }

    /**
     * Get indexing statistics
     */
    async getStats(): Promise<IndexingStats | null> {
        if (!this.orchestrator) {
            return null;
        }

        return await this.orchestrator.getIndexingStats();
    }

    /**
     * Manually trigger indexing
     */
    async triggerIndexing(): Promise<void> {
        if (!this.isInitialized || !this.orchestrator) {
            throw new Error('IndexingManager not initialized');
        }

        if (this.isIndexing) {
            throw new Error('Indexing already in progress');
        }

        this.outputChannel.appendLine('[IndexingManager] Manual indexing triggered');
        await this.performPeriodicIndexing();
    }

    /**
     * Enable/disable indexing
     */
    setEnabled(enabled: boolean): void {
        this.config.enabled = enabled;
        this.outputChannel.appendLine(`[IndexingManager] Indexing ${enabled ? 'enabled' : 'disabled'}`);

        if (!enabled) {
            this.statusInfo.status = 'disabled';
        } else if (this.isInitialized) {
            this.statusInfo.status = 'idle';
        }

        this.emit('statusChanged', this.statusInfo);
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<IndexingManagerConfig>): void {
        const oldInterval = this.config.indexingInterval;
        this.config = { ...this.config, ...newConfig };

        // Restart timer if interval changed
        if (this.config.indexingInterval !== oldInterval && this.indexingTimer) {
            this.startPeriodicIndexing();
        }

        this.outputChannel.appendLine('[IndexingManager] Configuration updated');
    }

    /**
     * Dispose of the indexing manager
     */
    async dispose(): Promise<void> {
        this.outputChannel.appendLine('[IndexingManager] Disposing...');

        // Stop periodic indexing
        if (this.indexingTimer) {
            clearInterval(this.indexingTimer);
            this.indexingTimer = null;
        }

        // Dispose orchestrator
        if (this.orchestrator) {
            this.orchestrator.dispose();
            this.orchestrator = null;
        }

        // Clean up server communication
        this.serverCommunication = null;

        // Dispose VSCode listeners
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];

        this.isInitialized = false;
        this.removeAllListeners();

        this.outputChannel.appendLine('[IndexingManager] Disposed');
    }
} 