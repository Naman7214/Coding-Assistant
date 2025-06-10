import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { CollectorMetadata, RecentEditsCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';
import { DiffGenerator } from './recent-edits/DiffGenerator';
import { MerkleTreeManager } from './recent-edits/MerkleTreeManager';
import { SnapshotManager } from './recent-edits/SnapshotManager';

/**
 * Collects recent edits in the workspace over the last 3 minutes
 * Uses merkle tree comparison and line-level diffs
 * No caching - always provides fresh data
 */
export class RecentEditsCollector extends BaseCollector {
    private merkleTreeManager: MerkleTreeManager;
    private snapshotManager: SnapshotManager;
    private diffGenerator: DiffGenerator;
    private checkIntervalTimer: NodeJS.Timeout | null = null;
    private readonly CHECK_INTERVAL_MS = 1 *60 * 1000; // 3 minutes
    private isInitialized = false;
    private currentGitBranch = 'default';
    private readonly context: vscode.ExtensionContext;

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string,
        context: vscode.ExtensionContext
    ) {
        super(
            'RecentEditsCollector',
            'recent_edits',
            8.0, // High priority - needed for every query
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 0, // No caching - always fresh data
                options: {
                    enabled: true,
                    checkInterval: 3, // 3 minutes
                    maxFilesToTrack: 1000,
                    gitBranchAware: true,
                    enableCleanup: true,
                    contextLines: 3
                }
            }
        );

        this.context = context;

        // Initialize managers
        this.merkleTreeManager = new MerkleTreeManager(context, outputChannel, workspaceId);
        this.snapshotManager = new SnapshotManager(context, outputChannel, workspaceId);
        this.diffGenerator = new DiffGenerator(outputChannel);

        this.outputChannel.appendLine('[RecentEditsCollector] Initialized with 3-minute tracking interval');
    }

    async canCollect(): Promise<boolean> {
        const workspacePath = this.getWorkspacePath();
        if (!workspacePath) {
            return false;
        }

        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(workspacePath));
            return true;
        } catch {
            return false;
        }
    }

    async collect(): Promise<ContextData | null> {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!workspacePath) {
                return null;
            }

            // Initialize if not done yet
            if (!this.isInitialized) {
                await this.initialize(workspacePath);
            }

            // Get current git branch
            this.currentGitBranch = await this.getCurrentGitBranch(workspacePath);

            // Perform change detection
            const changesData = await this.detectRecentChanges(workspacePath);

            return this.createContextData(
                this.generateId(),
                changesData,
                {
                    hasChanges: changesData.summary.hasChanges,
                    totalFiles: changesData.summary.totalFiles,
                    gitBranch: this.currentGitBranch,
                    timestamp: Date.now()
                }
            );

        } catch (error) {
            this.error('Failed to collect recent edits', error);
            return this.createContextData(
                this.generateId(),
                this.createEmptyResult(),
                {
                    hasChanges: false,
                    totalFiles: 0,
                    gitBranch: this.currentGitBranch,
                    timestamp: Date.now()
                }
            );
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: 'Recent Edits Collector',
            description: 'Tracks file changes in the last 3 minutes using merkle tree comparison and line-level diffs',
            version: '1.0.0',
            dependencies: ['fast-myers-diff', 'VS Code workspace storage'],
            configurable: true,
            cacheable: false, // Always fresh data
            priority: 8 // High priority for must-send context
        };
    }

    /**
     * Initialize the recent edits tracking system
     */
    private async initialize(workspacePath: string): Promise<void> {
        try {
            this.outputChannel.appendLine('[RecentEditsCollector] Initializing recent edits tracking...');

            // Get current git branch
            this.currentGitBranch = await this.getCurrentGitBranch(workspacePath);

            // Build initial merkle tree
            const initialTree = await this.merkleTreeManager.buildMerkleTree(workspacePath);
            if (initialTree) {
                await this.merkleTreeManager.storeMerkleTree(initialTree, this.currentGitBranch);
                this.outputChannel.appendLine(
                    `[RecentEditsCollector] Initial merkle tree stored for branch '${this.currentGitBranch}'`
                );
            }

            // CRITICAL: Create initial snapshots for ENTIRE codebase
            await this.createInitialCodebaseSnapshots(workspacePath);

            // Start the 3-minute interval timer
            this.startPeriodicChecks(workspacePath);

            // Perform initial cleanup
            await this.performCleanup();

            this.isInitialized = true;
            this.outputChannel.appendLine('[RecentEditsCollector] Initialization completed');

        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Initialization failed: ${error}`);
            throw error;
        }
    }

    /**
     * Create initial snapshots for the ENTIRE codebase
     * This is critical to have a complete baseline for comparison
     */
    private async createInitialCodebaseSnapshots(workspacePath: string): Promise<void> {
        try {
            this.outputChannel.appendLine('[RecentEditsCollector] Creating initial snapshots for entire codebase...');

            // Get all files in the codebase (excluding ignored patterns)
            const allFiles = await this.getAllCodebaseFiles(workspacePath);

            this.outputChannel.appendLine(`[RecentEditsCollector] Found ${allFiles.length} files to snapshot`);

            // Store snapshots for ALL files in the codebase
            const result = await this.snapshotManager.storeMultipleSnapshots(allFiles, this.currentGitBranch);

            this.outputChannel.appendLine(
                `[RecentEditsCollector] Initial snapshots completed: ${result.success.length} success, ` +
                `${result.failed.length} failed`
            );

        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Error creating initial snapshots: ${error}`);
            throw error;
        }
    }

    /**
     * Get all files in the codebase (excluding build artifacts and ignored files)
     */
    private async getAllCodebaseFiles(workspacePath: string): Promise<string[]> {
        const files: string[] = [];

        // Define patterns to exclude (same as MerkleTreeBuilder)
        const excludePatterns = [
            'node_modules/**', '.git/**', '**/.git/**', '**/*.log',
            '**/dist/**', '**/build/**', '**/.DS_Store', '**/thumbs.db',
            '.venv/**', '**/.venv/**', '**/site-packages/**', '**/lib/python*/**',
            '**/bin/**', '**/__pycache__/**', '**/*.pyc', 'env/**', '**/.env/**',
            '**/tmp/**', '**/temp/**', '**/.cache/**', '**/coverage/**',
            '**/.nyc_output/**', '**/out/**', '**/.next/**', '**/.nuxt/**'
        ];

        // Define patterns to include (same as MerkleTreeBuilder)
        const includePatterns = [
            '**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.vue',
            '**/*.py', '**/*.java', '**/*.cpp', '**/*.c', '**/*.h',
            '**/*.cs', '**/*.php', '**/*.rb', '**/*.go', '**/*.rs',
            '**/*.swift', '**/*.kt', '**/*.scala', '**/*.sh',
            '**/*.yaml', '**/*.yml', '**/*.json', '**/*.xml',
            '**/*.md', '**/*.txt', '**/*.sql', '**/*.css', '**/*.scss',
            '**/*.less', '**/*.html', '**/*.htm'
        ];

        try {
            // Use VS Code's workspace.findFiles with patterns
            const fileUris = await vscode.workspace.findFiles(
                `{${includePatterns.join(',')}}`, // include
                `{${excludePatterns.join(',')}}`, // exclude
                10000 // max results
            );

            // Convert URIs to file paths
            for (const uri of fileUris) {
                files.push(uri.fsPath);
            }

            this.outputChannel.appendLine(`[RecentEditsCollector] Scanned codebase: ${files.length} files found`);
            return files;

        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Error scanning codebase: ${error}`);
            return [];
        }
    }

    /**
     * Start periodic checks every 3 minutes
     */
    private startPeriodicChecks(workspacePath: string): void {
        if (this.checkIntervalTimer) {
            clearInterval(this.checkIntervalTimer);
        }

        this.checkIntervalTimer = setInterval(async () => {
            try {
                await this.performPeriodicCheck(workspacePath);
            } catch (error) {
                this.outputChannel.appendLine(`[RecentEditsCollector] Periodic check failed: ${error}`);
            }
        }, this.CHECK_INTERVAL_MS);

        this.outputChannel.appendLine(
            `[RecentEditsCollector] Started periodic checks every ${this.CHECK_INTERVAL_MS / 1000}s`
        );
    }

    /**
 * Perform periodic check to detect changes (but don't update snapshots yet)
 */
    private async performPeriodicCheck(workspacePath: string): Promise<void> {
        try {
            const currentBranch = await this.getCurrentGitBranch(workspacePath);

            // Check if branch changed
            if (currentBranch !== this.currentGitBranch) {
                this.outputChannel.appendLine(
                    `[RecentEditsCollector] Git branch changed: ${this.currentGitBranch} → ${currentBranch}`
                );
                this.currentGitBranch = currentBranch;
            }

            // Build new merkle tree
            const newTree = await this.merkleTreeManager.buildMerkleTree(workspacePath);
            if (!newTree) {
                return;
            }

            // Get previous tree
            const oldTree = await this.merkleTreeManager.retrieveMerkleTree(this.currentGitBranch);

            // Compare trees to find changes (for logging only)
            const changes = this.merkleTreeManager.compareTreesForChanges(oldTree, newTree);

            // Just log what was detected - don't update snapshots yet
            // The snapshots will be updated during diff generation in detectRecentChanges
            if (changes.changedFiles.length > 0 || changes.deletedFiles.length > 0) {
                this.outputChannel.appendLine(
                    `[RecentEditsCollector] Periodic check detected: ${changes.changedFiles.length} changed, ` +
                    `${changes.deletedFiles.length} deleted files`
                );
            }

            // Store updated merkle tree to mark the current state
            await this.merkleTreeManager.storeMerkleTree(newTree, this.currentGitBranch);

        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Periodic check error: ${error}`);
        }
    }

    /**
     * Detect recent changes by comparing merkle trees and snapshots
     */
    private async detectRecentChanges(workspacePath: string): Promise<RecentEditsCollectorData> {
        try {
            // Build current merkle tree
            const currentTree = await this.merkleTreeManager.buildMerkleTree(workspacePath);
            if (!currentTree) {
                return this.createEmptyResult();
            }

            // Get previous tree for comparison
            const previousTree = await this.merkleTreeManager.retrieveMerkleTree(this.currentGitBranch);

            // Compare trees to get changed and deleted files
            const comparison = this.merkleTreeManager.compareTreesForChanges(previousTree, currentTree);

            this.outputChannel.appendLine(
                `[RecentEditsCollector] Merkle tree comparison: ${comparison.changedFiles.length} changed, ` +
                `${comparison.deletedFiles.length} deleted files`
            );

            // Process all changes using merkle tree results
            const { modifiedFiles, addedFiles, deletedFiles } = await this.processFileChanges(
                comparison.changedFiles,
                comparison.deletedFiles
            );

            // Update merkle tree and all snapshots
            await this.merkleTreeManager.storeMerkleTree(currentTree, this.currentGitBranch);
            await this.updateAllSnapshots(await this.getAllCodebaseFiles(workspacePath), deletedFiles);

            const result: RecentEditsCollectorData = {
                summary: {
                    hasChanges: modifiedFiles.length > 0 || addedFiles.length > 0 || deletedFiles.length > 0,
                    timeWindow: 'last 3 minutes',
                    totalFiles: modifiedFiles.length + addedFiles.length + deletedFiles.length,
                    checkInterval: this.CHECK_INTERVAL_MS
                },
                modifiedFiles,
                addedFiles,
                deletedFiles,
                timestamp: Date.now(),
                gitBranch: this.currentGitBranch,
                workspaceHash: this.workspaceId
            };

            this.outputChannel.appendLine(
                `[RecentEditsCollector] Detected changes: ${modifiedFiles.length} modified, ` +
                `${addedFiles.length} added, ${deletedFiles.length} deleted`
            );

            return result;

        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Error detecting changes: ${error}`);
            return this.createEmptyResult();
        }
    }

    /**
     * Process file changes using merkle tree comparison results
     */
    private async processFileChanges(
        changedFiles: string[],
        deletedFiles: string[]
    ): Promise<{
        modifiedFiles: RecentEditsCollectorData['modifiedFiles'];
        addedFiles: RecentEditsCollectorData['addedFiles'];
        deletedFiles: RecentEditsCollectorData['deletedFiles'];
    }> {
        const modifiedFiles: RecentEditsCollectorData['modifiedFiles'] = [];
        const addedFiles: RecentEditsCollectorData['addedFiles'] = [];
        const processedDeletedFiles: RecentEditsCollectorData['deletedFiles'] = [];

        this.outputChannel.appendLine(`[RecentEditsCollector] Processing ${changedFiles.length} changed files and ${deletedFiles.length} deleted files`);

        // Process changed files (could be modified or newly added)
        for (const filePath of changedFiles) {
            try {
                // Get current content
                const currentContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
                const currentContentStr = Buffer.from(currentContent).toString('utf8');

                // Check if we have a snapshot for this file
                const hasSnapshot = await this.snapshotManager.hasSnapshot(filePath, this.currentGitBranch);

                if (hasSnapshot) {
                    // File exists in snapshot - check if content changed
                    const previousContent = await this.snapshotManager.retrieveSnapshot(filePath, this.currentGitBranch);

                    if (previousContent !== null && previousContent !== currentContentStr) {
                        // Generate diff for modified file
                        const diff = await this.diffGenerator.generateContextualDiff(
                            previousContent,
                            currentContentStr,
                            filePath
                        );

                        if (diff.changes.length > 0) {
                            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));

                            modifiedFiles.push({
                                filePath: filePath,
                                relativePath: this.getRelativePath(filePath),
                                changes: diff.changes,
                                changeType: 'modified',
                                lastModified: new Date(stat.mtime).toISOString()
                            });

                            this.outputChannel.appendLine(
                                `[RecentEditsCollector] Modified: ${path.basename(filePath)} (${diff.changes.length} changes)`
                            );
                        }
                    }
                } else {
                    // No snapshot exists - this is a new file
                    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));

                    addedFiles.push({
                        filePath: filePath,
                        relativePath: this.getRelativePath(filePath),
                        changeType: 'added',
                        lastModified: new Date(stat.mtime).toISOString()
                    });

                    this.outputChannel.appendLine(`[RecentEditsCollector] Added: ${path.basename(filePath)}`);
                }
            } catch (error) {
                this.outputChannel.appendLine(`[RecentEditsCollector] Error processing changed file ${filePath}: ${error}`);
            }
        }

        // Process deleted files (from merkle tree comparison)
        for (const filePath of deletedFiles) {
            try {
                processedDeletedFiles.push({
                    filePath: filePath,
                    relativePath: this.getRelativePath(filePath),
                    changeType: 'deleted',
                    lastModified: new Date().toISOString() // Current time since file no longer exists
                });

                this.outputChannel.appendLine(`[RecentEditsCollector] Deleted: ${path.basename(filePath)}`);
            } catch (error) {
                this.outputChannel.appendLine(`[RecentEditsCollector] Error processing deleted file ${filePath}: ${error}`);
            }
        }

        this.outputChannel.appendLine(
            `[RecentEditsCollector] Processing complete: ${modifiedFiles.length} modified, ` +
            `${addedFiles.length} added, ${processedDeletedFiles.length} deleted`
        );

        return { modifiedFiles, addedFiles, deletedFiles: processedDeletedFiles };
    }

    /**
     * Update ALL snapshots to reflect current codebase state
     */
    private async updateAllSnapshots(currentFiles: string[], deletedFiles: RecentEditsCollectorData['deletedFiles']): Promise<void> {
        try {
            this.outputChannel.appendLine(`[RecentEditsCollector] Updating snapshots for ${currentFiles.length} current files`);

            // Store/update snapshots for all current files
            const result = await this.snapshotManager.storeMultipleSnapshots(currentFiles, this.currentGitBranch);

            this.outputChannel.appendLine(
                `[RecentEditsCollector] Snapshot update: ${result.success.length} success, ${result.failed.length} failed`
            );

            // Clean up snapshots for deleted files
            for (const deletedFile of deletedFiles) {
                try {
                    await this.snapshotManager.deleteSnapshot(deletedFile.filePath, this.currentGitBranch);
                    this.outputChannel.appendLine(`[RecentEditsCollector] Cleaned up snapshot for deleted file: ${path.basename(deletedFile.filePath)}`);
                } catch (error) {
                    this.outputChannel.appendLine(`[RecentEditsCollector] Error cleaning up snapshot for ${deletedFile.filePath}: ${error}`);
                }
            }

        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Error updating snapshots: ${error}`);
        }
    }





    /**
     * Get current git branch
     */
    private async getCurrentGitBranch(workspacePath: string): Promise<string> {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const git = gitExtension.exports.getAPI(1);
                const repo = git.repositories.find((r: any) =>
                    workspacePath.startsWith(r.rootUri.fsPath)
                );

                if (repo && repo.state.HEAD?.name) {
                    return repo.state.HEAD.name;
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Error getting git branch: ${error}`);
        }

        return 'default';
    }

    /**
     * Perform cleanup of old data
     */
    private async performCleanup(): Promise<void> {
        try {
            if (!this.config.options.enableCleanup) {
                return;
            }

            // Get existing branches (simplified - in real implementation, would query git)
            const existingBranches = [this.currentGitBranch];

            // Cleanup old merkle trees
            await this.merkleTreeManager.cleanupOldTrees(this.currentGitBranch, existingBranches);

            // Cleanup old snapshots
            await this.snapshotManager.cleanupSnapshots(this.currentGitBranch, existingBranches);

            this.outputChannel.appendLine('[RecentEditsCollector] Cleanup completed');
        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Cleanup error: ${error}`);
        }
    }

    /**
     * Create empty result when no changes are detected
     */
    private createEmptyResult(): RecentEditsCollectorData {
        return {
            summary: {
                hasChanges: false,
                timeWindow: 'last 3 minutes',
                totalFiles: 0,
                checkInterval: this.CHECK_INTERVAL_MS
            },
            modifiedFiles: [],
            addedFiles: [],
            deletedFiles: [],
            timestamp: Date.now(),
            gitBranch: this.currentGitBranch,
            workspaceHash: this.workspaceId
        };
    }

    /**
     * Get storage statistics for monitoring
     */
    async getStorageStats(): Promise<{
        merkleTreeStats: any;
        snapshotStats: any;
    }> {
        try {
            const [merkleTreeStats, snapshotStats] = await Promise.all([
                this.merkleTreeManager.getStorageStats(),
                this.snapshotManager.getStorageStats()
            ]);

            return { merkleTreeStats, snapshotStats };
        } catch (error) {
            this.outputChannel.appendLine(`[RecentEditsCollector] Error getting storage stats: ${error}`);
            return {
                merkleTreeStats: { totalTrees: 0, totalSize: 0, branches: [] },
                snapshotStats: { totalSnapshots: 0, totalSize: 0, snapshotsByBranch: {} }
            };
        }
    }

    /**
     * Cleanup resources when disposing
     */
    dispose(): void {
        if (this.checkIntervalTimer) {
            clearInterval(this.checkIntervalTimer);
            this.checkIntervalTimer = null;
        }

        this.outputChannel.appendLine('[RecentEditsCollector] Disposed');
        super.dispose();
    }
}
