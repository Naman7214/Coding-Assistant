import * as fs from 'fs';
import * as vscode from 'vscode';
import { VSCodeStorageManager } from '../storage/vscode-storage';
import {
    CodeChunk,
    IndexingStats
} from '../types/chunk';
import { hashWorkspacePath } from '../utils/hash';
import { GitMonitor } from './git-monitor';
import { MerkleTreeBuilder } from './merkle-tree-builder';
import { TreeSitterChunker } from './tree-sitter-chunker';

export class IndexingOrchestrator {
    private context: vscode.ExtensionContext;
    private workspacePath: string;
    private workspaceHash: string;
    private merkleTreeBuilder: MerkleTreeBuilder;
    private treeSitterChunker: TreeSitterChunker;
    private gitMonitor: GitMonitor;
    private storageManager: VSCodeStorageManager;
    private outputChannel: vscode.OutputChannel;

    private indexingTimer: NodeJS.Timeout | null = null;
    private isIndexing: boolean = false;
    private disposables: vscode.Disposable[] = [];

    // Configuration
    private readonly INDEXING_INTERVAL = 10 * 60 * 1000; // 10 minutes
    private readonly MAX_CONCURRENT_FILES = 10;

    // Callbacks
    private onIndexingStartCallback?: () => void;
    private onIndexingCompleteCallback?: (stats: IndexingStats) => void;
    private onChunksReadyCallback?: (chunks: CodeChunk[]) => void;

    constructor(context: vscode.ExtensionContext, workspacePath: string, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.workspacePath = workspacePath;
        this.workspaceHash = hashWorkspacePath(workspacePath);
        this.outputChannel = outputChannel;

        // Initialize components
        this.merkleTreeBuilder = new MerkleTreeBuilder([], [], outputChannel);
        this.treeSitterChunker = new TreeSitterChunker(this.workspaceHash, 'default');
        this.gitMonitor = new GitMonitor(workspacePath);
        this.storageManager = new VSCodeStorageManager(context, this.workspaceHash);
    }

    /**
     * Initialize the indexing orchestrator
     */
    async initialize(): Promise<void> {
        try {
            this.outputChannel.appendLine('[IndexingOrchestrator] Initializing code base indexing...');

            // Initialize Git monitoring
            await this.gitMonitor.initialize();

            // Set up Git branch change listener
            this.gitMonitor.onBranchChange(async (newBranch, oldBranch) => {
                this.outputChannel.appendLine(`[IndexingOrchestrator] Branch changed from ${oldBranch} to ${newBranch}, triggering full reindex`);
                await this.handleBranchChange(newBranch);
            });

            // Load or create initial configuration
            await this.loadOrCreateConfig();

            // Start the indexing timer (but don't perform initial indexing here)
            this.startIndexingTimer();

            this.outputChannel.appendLine('[IndexingOrchestrator] Code base indexing initialized successfully');

        } catch (error) {
            this.outputChannel.appendLine(`[IndexingOrchestrator] Failed to initialize indexing orchestrator: ${error}`);
            throw error;
        }
    }

    /**
     * Set callback for indexing start
     */
    onIndexingStart(callback: () => void): void {
        this.onIndexingStartCallback = callback;
    }

    /**
     * Set callback for indexing completion
     */
    onIndexingComplete(callback: (stats: IndexingStats) => void): void {
        this.onIndexingCompleteCallback = callback;
    }

    /**
     * Set callback for when chunks are ready for server transmission
     */
    onChunksReady(callback: (chunks: CodeChunk[]) => void): void {
        this.onChunksReadyCallback = callback;
    }

    /**
     * Manually trigger indexing
     */
    async triggerIndexing(): Promise<void> {
        if (this.isIndexing) {
            this.outputChannel.appendLine('Indexing already in progress, skipping trigger');
            return;
        }

        await this.performIndexing();
    }

    /**
     * Get current indexing statistics
     */
    async getIndexingStats(): Promise<IndexingStats> {
        const config = await this.storageManager.loadConfig();
        const storageStats = await this.storageManager.getStorageStats();

        return {
            totalChunks: 0, // Would need to track this
            totalFiles: 0,  // Would need to track this
            lastIndexTime: config?.lastIndexTime || 0,
            processingTime: 0, // Tracked during indexing
            changedFiles: 0    // Tracked during indexing
        };
    }

    /**
     * Load or create initial configuration
     */
    private async loadOrCreateConfig(): Promise<void> {
        let config = await this.storageManager.loadConfig();

        if (!config) {
            const currentBranch = await this.gitMonitor.getCurrentBranch();

            config = {
                workspaceHash: this.workspaceHash,
                lastIndexTime: 0,
                merkleTreeRoot: '',
                gitBranch: currentBranch,
                excludePatterns: [],
                includePatterns: []
            };

            await this.storageManager.saveConfig(config);
        }

        // Update chunker with current branch
        this.treeSitterChunker = new TreeSitterChunker(this.workspaceHash, config.gitBranch);
    }

    /**
     * Start the periodic indexing timer
     */
    private startIndexingTimer(): void {
        this.indexingTimer = setInterval(async () => {
            await this.performIndexing();
        }, this.INDEXING_INTERVAL);

        this.disposables.push({
            dispose: () => {
                if (this.indexingTimer) {
                    clearInterval(this.indexingTimer);
                    this.indexingTimer = null;
                }
            }
        });
    }

    /**
     * Perform the main indexing process
     */
    private async performIndexing(): Promise<void> {
        if (this.isIndexing) {
            return;
        }

        this.isIndexing = true;
        const startTime = Date.now();

        try {
            if (this.onIndexingStartCallback) {
                this.onIndexingStartCallback();
            }

            this.outputChannel.appendLine(`[IndexingOrchestrator] Starting code base indexing for workspace: ${this.workspacePath}`);

            // Validate workspace path exists
            const workspaceExists = await fs.promises.access(this.workspacePath).then(() => true).catch(() => false);
            if (!workspaceExists) {
                throw new Error(`Workspace path does not exist: ${this.workspacePath}`);
            }

            // Build new merkle tree
            const newMerkleTree = await this.merkleTreeBuilder.buildTree(this.workspacePath);
            this.outputChannel.appendLine(`[IndexingOrchestrator] Built new merkle tree with hash: ${newMerkleTree.hash}`);

            // Load previous merkle tree
            const oldMerkleTree = await this.storageManager.loadMerkleTree();
            this.outputChannel.appendLine(`Loaded old merkle tree: ${oldMerkleTree ? 'Found' : 'Not found'}`);

            // Compare trees to find changed files
            const changedFiles = this.merkleTreeBuilder.compareTree(oldMerkleTree, newMerkleTree);

            this.outputChannel.appendLine(`Found ${changedFiles.length} changed files`);
            if (changedFiles.length > 0) {
                this.outputChannel.appendLine(`Changed files: (${changedFiles.length}) ${JSON.stringify(changedFiles.slice(0, 5))}`); // Log first 5 files
            } else {
                this.outputChannel.appendLine('No changed files detected - checking if this is expected');
                this.outputChannel.appendLine(`Workspace path: ${this.workspacePath}`);
                this.outputChannel.appendLine(`New tree children count: ${newMerkleTree.children?.length || 0}`);
            }

            if (changedFiles.length > 0) {
                // Process changed files to extract chunks
                const chunks = await this.processChangedFiles(changedFiles);

                if (chunks.length > 0) {
                    this.outputChannel.appendLine(`Extracted ${chunks.length} chunks from ${changedFiles.length} changed files`);

                    // Send chunks directly to server (no local storage)
                    if (this.onChunksReadyCallback) {
                        this.onChunksReadyCallback(chunks);
                    }
                }
            }

            // Save new merkle tree
            await this.storageManager.saveMerkleTree(newMerkleTree);

            // Update configuration
            const config = await this.storageManager.loadConfig();
            if (config) {
                config.lastIndexTime = Date.now();
                config.merkleTreeRoot = newMerkleTree.hash;
                await this.storageManager.saveConfig(config);
            }

            // No local chunk cleanup needed - chunks are sent directly to server

            const processingTime = Date.now() - startTime;
            const stats: IndexingStats = {
                totalChunks: 0, // Would be calculated from chunks
                totalFiles: changedFiles.length,
                lastIndexTime: Date.now(),
                processingTime,
                changedFiles: changedFiles.length
            };

            this.outputChannel.appendLine(`Indexing completed in ${processingTime}ms`);

            if (this.onIndexingCompleteCallback) {
                this.onIndexingCompleteCallback(stats);
            }

        } catch (error) {
            this.outputChannel.appendLine('Error during indexing:');
            this.outputChannel.appendLine(error.message);
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Process changed files to extract chunks
     */
    private async processChangedFiles(filePaths: string[]): Promise<CodeChunk[]> {
        const allChunks: CodeChunk[] = [];
        const errors: string[] = [];

        // Process files in batches to avoid overwhelming the system
        for (let i = 0; i < filePaths.length; i += this.MAX_CONCURRENT_FILES) {
            const batch = filePaths.slice(i, i + this.MAX_CONCURRENT_FILES);

            const batchPromises = batch.map(async (filePath) => {
                try {
                    const chunks = await this.treeSitterChunker.chunkFile(filePath);
                    return chunks;
                } catch (error) {
                    errors.push(`Error processing ${filePath}: ${error}`);
                    return [];
                }
            });

            const batchResults = await Promise.all(batchPromises);

            // Flatten and add to all chunks
            for (const chunks of batchResults) {
                allChunks.push(...chunks);
            }
        }

        if (errors.length > 0) {
            this.outputChannel.appendLine('Errors during file processing:');
            this.outputChannel.appendLine(errors.join('\n'));
        }

        return allChunks;
    }

    /**
     * Handle Git branch changes
     */
    private async handleBranchChange(newBranch: string): Promise<void> {
        try {
            this.outputChannel.appendLine(`Handling branch change to: ${newBranch}`);

            // Update chunker with new branch
            this.treeSitterChunker = new TreeSitterChunker(this.workspaceHash, newBranch);

            // Update configuration
            const config = await this.storageManager.loadConfig();
            if (config) {
                config.gitBranch = newBranch;
                await this.storageManager.saveConfig(config);
            }

            // Clear old merkle tree to force full reindex
            await this.storageManager.saveMerkleTree({
                hash: '',
                filePath: this.workspacePath,
                lastModified: 0,
                fileSize: 0,
                children: []
            });

            // Trigger immediate indexing
            await this.performIndexing();

        } catch (error) {
            this.outputChannel.appendLine('Error handling branch change:');
            this.outputChannel.appendLine(error.message);
        }
    }

    /**
     * Dispose of all resources
     */
    dispose(): void {
        this.outputChannel.appendLine('Disposing indexing orchestrator...');

        if (this.indexingTimer) {
            clearInterval(this.indexingTimer);
            this.indexingTimer = null;
        }

        this.gitMonitor.dispose();

        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];

        this.isIndexing = false;
    }
} 