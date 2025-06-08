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
    private currentGitBranch: string = 'default';

    private indexingTimer: NodeJS.Timeout | null = null;
    private isIndexing: boolean = false;
    private disposables: vscode.Disposable[] = [];

    // Configuration
    // private readonly INDEXING_INTERVAL = 10 * 60 * 1000; // 10 minutes
    private readonly INDEXING_INTERVAL = 60 * 3000; // 10 minutes
    private readonly MAX_CONCURRENT_FILES = 10;

    // Callbacks
    private onIndexingStartCallback?: () => void;
    private onIndexingCompleteCallback?: (stats: IndexingStats) => void;
    private onChunksReadyCallback?: (chunks: CodeChunk[], deletedFiles: string[]) => void;
    private onBranchChangeCallback?: (newBranch: string, oldBranch: string) => void;

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
            this.currentGitBranch = await this.gitMonitor.getCurrentBranch();

            // Set up Git branch change listener
            this.gitMonitor.onBranchChange(async (newBranch, oldBranch) => {
                this.outputChannel.appendLine(`[IndexingOrchestrator] Branch changed from ${oldBranch} to ${newBranch}`);
                await this.handleBranchChange(newBranch, oldBranch);
            });

            // Load or create initial configuration for current branch
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
    onChunksReady(callback: (chunks: CodeChunk[], deletedFiles: string[]) => void): void {
        this.onChunksReadyCallback = callback;
    }

    /**
     * Set callback for branch changes
     */
    onBranchChange(callback: (newBranch: string, oldBranch: string) => void): void {
        this.onBranchChangeCallback = callback;
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
        const config = await this.storageManager.loadConfig(this.currentGitBranch);
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
     * Load or create initial configuration for current branch
     */
    private async loadOrCreateConfig(): Promise<void> {
        let config = await this.storageManager.loadConfig(this.currentGitBranch);

        if (!config) {
            config = {
                workspaceHash: this.workspaceHash,
                lastIndexTime: 0,
                merkleTreeRoot: '',
                gitBranch: this.currentGitBranch,
                excludePatterns: [],
                includePatterns: []
            };

            await this.storageManager.saveConfig(config);
            this.outputChannel.appendLine(`[IndexingOrchestrator] Created new config for branch: ${this.currentGitBranch}`);
        } else {
            this.outputChannel.appendLine(`[IndexingOrchestrator] Loaded existing config for branch: ${this.currentGitBranch}`);
        }

        // Update chunker with current branch
        this.treeSitterChunker = new TreeSitterChunker(this.workspaceHash, this.currentGitBranch);
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

            this.outputChannel.appendLine(`[IndexingOrchestrator] Starting code base indexing for workspace: ${this.workspacePath}, branch: ${this.currentGitBranch}`);

            // Validate workspace path exists
            const workspaceExists = await fs.promises.access(this.workspacePath).then(() => true).catch(() => false);
            if (!workspaceExists) {
                throw new Error(`Workspace path does not exist: ${this.workspacePath}`);
            }

            // Build new merkle tree
            const newMerkleTree = await this.merkleTreeBuilder.buildTree(this.workspacePath);
            this.outputChannel.appendLine(`[IndexingOrchestrator] Built new merkle tree with hash: ${newMerkleTree.hash}`);

            // Load previous merkle tree for current branch
            const oldMerkleTree = await this.storageManager.loadMerkleTree(this.currentGitBranch);
            this.outputChannel.appendLine(`Loaded old merkle tree for branch ${this.currentGitBranch}: ${oldMerkleTree ? 'Found' : 'Not found'}`);

            // Compare trees to find changed and deleted files
            const comparisonResult = this.merkleTreeBuilder.compareTree(oldMerkleTree, newMerkleTree);
            const { changedFiles, deletedFiles } = comparisonResult;

            this.outputChannel.appendLine(`Found ${changedFiles.length} changed files and ${deletedFiles.length} deleted files for branch ${this.currentGitBranch}`);
            if (changedFiles.length > 0) {
                this.outputChannel.appendLine(`Changed files: (${changedFiles.length}) ${JSON.stringify(changedFiles.slice(0, 5))}`); // Log first 5 files
            }
            if (deletedFiles.length > 0) {
                this.outputChannel.appendLine(`Deleted files: (${deletedFiles.length}) ${JSON.stringify(deletedFiles.slice(0, 5))}`); // Log first 5 files
            }
            if (changedFiles.length === 0 && deletedFiles.length === 0) {
                this.outputChannel.appendLine('No changed or deleted files detected - checking if this is expected');
                this.outputChannel.appendLine(`Workspace path: ${this.workspacePath}`);
                this.outputChannel.appendLine(`New tree children count: ${newMerkleTree.children?.length || 0}`);
            }

            if (changedFiles.length > 0 || deletedFiles.length > 0) {
                // Process changed files to extract chunks
                const chunks = changedFiles.length > 0 ? await this.processChangedFiles(changedFiles) : [];

                if (chunks.length > 0 || deletedFiles.length > 0) {
                    this.outputChannel.appendLine(`Extracted ${chunks.length} chunks from ${changedFiles.length} changed files, ${deletedFiles.length} deleted files`);

                    // Send chunks and deleted files to server
                    if (this.onChunksReadyCallback) {
                        this.onChunksReadyCallback(chunks, deletedFiles);
                    }
                }
            }

            // Save new merkle tree for current branch
            await this.storageManager.saveMerkleTree(newMerkleTree, this.currentGitBranch);

            // Update configuration for current branch
            const config = await this.storageManager.loadConfig(this.currentGitBranch);
            if (config) {
                config.lastIndexTime = Date.now();
                config.merkleTreeRoot = newMerkleTree.hash;
                await this.storageManager.saveConfig(config);
            }

            const processingTime = Date.now() - startTime;
            const stats: IndexingStats = {
                totalChunks: 0, // Would be calculated from chunks
                totalFiles: changedFiles.length + deletedFiles.length,
                lastIndexTime: Date.now(),
                processingTime,
                changedFiles: changedFiles.length
            };

            this.outputChannel.appendLine(`Indexing completed in ${processingTime}ms for branch ${this.currentGitBranch}`);

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
     * Handle Git branch changes - load branch-specific merkle tree instead of deleting
     */
    private async handleBranchChange(newBranch: string, oldBranch: string): Promise<void> {
        try {
            this.outputChannel.appendLine(`Handling branch change from ${oldBranch} to: ${newBranch}`);

            // Update current branch
            this.currentGitBranch = newBranch;

            // Notify IndexingManager about branch change
            if (this.onBranchChangeCallback) {
                this.onBranchChangeCallback(newBranch, oldBranch);
            }

            // Update chunker with new branch
            this.treeSitterChunker = new TreeSitterChunker(this.workspaceHash, newBranch);

            // Load or create configuration for new branch
            await this.loadOrCreateConfig();

            // Check if we have merkle tree for this branch
            const existingMerkleTree = await this.storageManager.loadMerkleTree(newBranch);

            if (existingMerkleTree) {
                this.outputChannel.appendLine(`Found existing merkle tree for branch ${newBranch}, will compare changes`);
            } else {
                this.outputChannel.appendLine(`No existing merkle tree found for branch ${newBranch}, will perform full indexing`);
            }

            // Trigger immediate indexing (will compare with branch-specific merkle tree)
            await this.performIndexing();

            // Optional: Clean up merkle trees for branches that no longer exist
            // You could implement this by getting all git branches and calling cleanupOldBranches
            // For now, we'll keep all branch data for safety

        } catch (error) {
            this.outputChannel.appendLine('Error handling branch change:');
            this.outputChannel.appendLine(error.message);
        }
    }

    /**
     * Get current git branch
     */
    getCurrentBranch(): string {
        return this.currentGitBranch;
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