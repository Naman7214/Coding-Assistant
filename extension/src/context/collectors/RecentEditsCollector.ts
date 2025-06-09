import * as fs from 'fs';
import * as vscode from 'vscode';
import { MerkleTreeNode } from '../../indexing/types/chunk';
import { CollectorMetadata, RecentEditsCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';
import { DiffGenerator, MerkleTreeManager, SnapshotManager } from './recent-edits';

export class RecentEditsCollector extends BaseCollector {
    private snapshotManager: SnapshotManager | null = null;
    private diffGenerator: DiffGenerator;
    private merkleTreeManager: MerkleTreeManager | null = null;
    private checkTimer: NodeJS.Timeout | null = null;
    private readonly CHECK_INTERVAL = 3 * 60 * 1000; // 3 minutes in milliseconds
    private lastMerkleTree: MerkleTreeNode | null = null;
    private currentGitBranch: string = 'default';
    private isInitialized: boolean = false;
    private context: vscode.ExtensionContext;

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: any,
        workspaceId: string,
        context: vscode.ExtensionContext
    ) {
        super(
            'RecentEditsCollector',
            'recent_edits',
            8.0, // High weight - recent edits are important
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 0, // Disable caching - fresh data every time
                options: {
                    checkInterval: 3 * 60 * 1000, // 3 minutes
                    maxSnapshotAge: 24 * 60 * 60 * 1000, // 24 hours
                    debug: false
                }
            }
        );

        this.context = context;
        this.diffGenerator = new DiffGenerator(outputChannel);
        this.initializeAsync();
    }

    /**
     * Async initialization that doesn't block constructor
     */
    private async initializeAsync(): Promise<void> {
        try {
            await this.initialize();
        } catch (error) {
            this.error('Failed to initialize RecentEditsCollector', error);
        }
    }

    /**
     * Initialize the collector components
     */
    private async initialize(): Promise<void> {
        const workspaceFolder = this.getWorkspaceFolder();
        if (!workspaceFolder) {
            this.warn('No workspace folder available for RecentEditsCollector');
            return;
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        this.currentGitBranch = await this.getCurrentGitBranch();

        // Initialize managers
        this.merkleTreeManager = new MerkleTreeManager(workspacePath, this.outputChannel);
        this.snapshotManager = new SnapshotManager(
            this.context,
            this.workspaceId,
            this.currentGitBranch,
            this.outputChannel
        );

        // Build initial merkle tree and store it
        await this.buildAndStoreInitialTree();

        // Start the 3-minute check timer
        this.startCheckTimer();

        this.isInitialized = true;
        this.outputChannel.appendLine('[RecentEditsCollector] Initialized successfully');
    }

    async canCollect(): Promise<boolean> {
        return this.isValidVSCodeState() && this.isInitialized && !!this.getWorkspaceFolder();
    }

    async collect(): Promise<ContextData | null> {
        if (!this.isInitialized || !this.merkleTreeManager || !this.snapshotManager) {
            this.warn('RecentEditsCollector not initialized');
            return null;
        }

        try {
            // Get the current merkle tree
            const currentTree = await this.merkleTreeManager.buildCurrentTree();

            // Get the stored previous tree
            const storedTree = await this.getStoredMerkleTree();

            // Compare trees to find changes
            const comparison = this.merkleTreeManager.compareTree(storedTree, currentTree);

            // Process the changes and generate diffs
            const recentEditsData = await this.processFileChanges(comparison, currentTree, storedTree);

            const contextData = this.createContextData(
                this.generateId(),
                recentEditsData,
                {
                    checkInterval: this.CHECK_INTERVAL,
                    gitBranch: this.currentGitBranch,
                    workspaceId: this.workspaceId,
                    timestamp: Date.now()
                }
            );

            return contextData;

        } catch (error) {
            this.error('Failed to collect recent edits context', error);
            return null;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Tracks file changes in the last 3 minutes using merkle tree comparison and line-level diffs',
            version: '1.0.0',
            dependencies: ['vscode.workspace', 'fast-myers-diff'],
            configurable: true,
            cacheable: false, // Always fresh data
            priority: 8
        };
    }

    /**
     * Process file changes and generate diffs
     */
    private async processFileChanges(
        comparison: { changedFiles: string[]; deletedFiles: string[] },
        currentTree: MerkleTreeNode,
        storedTree: MerkleTreeNode | null
    ): Promise<RecentEditsCollectorData> {
        const modifiedFiles: RecentEditsCollectorData['modifiedFiles'] = [];
        const addedFiles: RecentEditsCollectorData['addedFiles'] = [];
        const deletedFiles: RecentEditsCollectorData['deletedFiles'] = [];

        // Process deleted files
        for (const filePath of comparison.deletedFiles) {
            try {
                // Clean up snapshot for deleted file
                await this.snapshotManager!.deleteSnapshot(filePath);

                deletedFiles.push({
                    filePath: filePath, // absolute path
                    relativePath: this.getRelativePath(filePath),
                    changeType: 'deleted',
                    lastModified: new Date().toISOString()
                });
            } catch (error) {
                this.warn(`Error processing deleted file ${filePath}: ${error}`);
            }
        }

        // Get all files from current tree to detect new files
        const currentFiles = this.merkleTreeManager!.getAllFilesFromTree(currentTree);
        const storedFiles = storedTree ? this.merkleTreeManager!.getAllFilesFromTree(storedTree) : [];

        // Find newly added files
        const newFiles = currentFiles.filter(file => !storedFiles.includes(file));

        // Process newly added files
        for (const filePath of newFiles) {
            try {
                const stats = await fs.promises.stat(filePath);
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const fileInfo = this.merkleTreeManager!.getFileInfo(currentTree, filePath);

                if (fileInfo) {
                    // Store snapshot for new file
                    await this.snapshotManager!.storeSnapshot(filePath, content, fileInfo.hash);
                }

                addedFiles.push({
                    filePath: filePath, // absolute path
                    relativePath: this.getRelativePath(filePath),
                    changeType: 'added',
                    lastModified: stats.mtime.toISOString()
                });
            } catch (error) {
                this.warn(`Error processing new file ${filePath}: ${error}`);
            }
        }

        // Process modified files
        for (const filePath of comparison.changedFiles) {
            try {
                // Skip if this is a new file (already processed above)
                if (newFiles.includes(filePath)) {
                    continue;
                }

                const snapshot = await this.snapshotManager!.getSnapshot(filePath);
                if (!snapshot) {
                    // No previous snapshot - create one for future comparisons
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    const fileInfo = this.merkleTreeManager!.getFileInfo(currentTree, filePath);
                    if (fileInfo) {
                        await this.snapshotManager!.storeSnapshot(filePath, content, fileInfo.hash);
                    }
                    continue;
                }

                // Read current content
                const currentContent = await fs.promises.readFile(filePath, 'utf-8');

                // Generate structured diffs with line numbers and content arrays
                const changes = this.diffGenerator.generateStructuredDiffs(
                    snapshot.content,
                    currentContent,
                    filePath
                );

                // Update snapshot with new content
                const fileInfo = this.merkleTreeManager!.getFileInfo(currentTree, filePath);
                if (fileInfo) {
                    await this.snapshotManager!.storeSnapshot(filePath, currentContent, fileInfo.hash);
                }

                const stats = await fs.promises.stat(filePath);
                modifiedFiles.push({
                    filePath: filePath, // absolute path
                    relativePath: this.getRelativePath(filePath),
                    changes,
                    changeType: 'modified',
                    lastModified: stats.mtime.toISOString()
                });

            } catch (error) {
                this.warn(`Error processing modified file ${filePath}: ${error}`);
            }
        }

        const totalChanges = modifiedFiles.length + addedFiles.length + deletedFiles.length;

        return {
            summary: {
                hasChanges: totalChanges > 0,
                timeWindow: 'last 3 minutes',
                totalFiles: totalChanges,
                checkInterval: this.CHECK_INTERVAL
            },
            modifiedFiles,
            addedFiles,
            deletedFiles,
            timestamp: Date.now(),
            gitBranch: this.currentGitBranch,
            workspaceHash: this.workspaceId
        };
    }

    /**
     * Build initial merkle tree and store it
     */
    private async buildAndStoreInitialTree(): Promise<void> {
        if (!this.merkleTreeManager) {
            return;
        }

        try {
            const tree = await this.merkleTreeManager.buildCurrentTree();
            await this.storeMerkleTree(tree);
            this.lastMerkleTree = tree;
            this.outputChannel.appendLine('[RecentEditsCollector] Initial merkle tree built and stored');
        } catch (error) {
            this.error('Failed to build initial merkle tree', error);
        }
    }

    /**
     * Start the 3-minute check timer
     */
    private startCheckTimer(): void {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
        }

        this.checkTimer = setInterval(async () => {
            await this.performPeriodicCheck();
        }, this.CHECK_INTERVAL);

        this.outputChannel.appendLine(`[RecentEditsCollector] Started 3-minute check timer`);
    }

    /**
     * Perform periodic check for file changes
     */
    private async performPeriodicCheck(): Promise<void> {
        if (!this.merkleTreeManager) {
            return;
        }

        try {
            const currentTree = await this.merkleTreeManager.buildCurrentTree();

            // Store the new tree for next comparison
            await this.storeMerkleTree(currentTree);
            this.lastMerkleTree = currentTree;

            this.outputChannel.appendLine('[RecentEditsCollector] Periodic check completed');
        } catch (error) {
            this.error('Error during periodic check', error);
        }
    }

    /**
     * Store merkle tree in VS Code storage
     */
    private async storeMerkleTree(tree: MerkleTreeNode): Promise<void> {
        try {
            const storageKey = `recent_changes_merkle_tree_${this.workspaceId}_${this.currentGitBranch}`;
            const serializedTree = this.merkleTreeManager!.serializeTree(tree);

            // Store in VS Code workspace state (workspace-specific storage)
            await this.context.workspaceState.update(storageKey, serializedTree);

            this.debug(`Stored merkle tree with key: ${storageKey}`);
        } catch (error) {
            this.error('Failed to store merkle tree', error);
        }
    }

    /**
     * Get stored merkle tree from VS Code storage
     */
    private async getStoredMerkleTree(): Promise<MerkleTreeNode | null> {
        try {
            const storageKey = `recent_changes_merkle_tree_${this.workspaceId}_${this.currentGitBranch}`;
            const storedData = this.context.workspaceState.get<string>(storageKey);

            if (storedData && this.merkleTreeManager) {
                this.debug(`Retrieved merkle tree with key: ${storageKey}`);
                return this.merkleTreeManager.deserializeTree(storedData);
            }
        } catch (error) {
            this.error('Failed to get stored merkle tree', error);
        }
        return null;
    }

    /**
     * Get current git branch
     */
    private async getCurrentGitBranch(): Promise<string> {
        try {
            const workspaceFolder = this.getWorkspaceFolder();
            if (!workspaceFolder) {
                return 'default';
            }

            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const git = gitExtension.exports.getAPI(1);
                const repo = git.repositories.find((r: any) =>
                    workspaceFolder.uri.fsPath.startsWith(r.rootUri.fsPath)
                );

                if (repo && repo.state.HEAD?.name) {
                    return repo.state.HEAD.name;
                }
            }
        } catch (error) {
            this.warn(`Could not get git branch: ${error}`);
        }
        return 'default';
    }

    /**
     * Handle git branch changes
     */
    private async handleGitBranchChange(newBranch: string): Promise<void> {
        if (this.currentGitBranch !== newBranch) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Git branch changed: ${this.currentGitBranch} -> ${newBranch}`);

            this.currentGitBranch = newBranch;

            // Update snapshot manager
            if (this.snapshotManager) {
                this.snapshotManager.updateGitBranch(newBranch);
                await this.snapshotManager.cleanupOldSnapshots();
            }

            // Rebuild initial tree for new branch
            await this.buildAndStoreInitialTree();
        }
    }

    /**
     * Disable caching for this collector
     */
    protected shouldUseCache(): boolean {
        return false; // Always collect fresh data
    }

    dispose(): void {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }

        this.outputChannel.appendLine('[RecentEditsCollector] Disposed');
        super.dispose();
    }
} 