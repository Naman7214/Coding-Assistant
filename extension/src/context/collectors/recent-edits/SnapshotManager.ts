import * as vscode from 'vscode';
import { SnapshotInfo } from '../../types/collectors';

export class SnapshotManager {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private workspaceHash: string;
    private gitBranch: string;

    constructor(
        context: vscode.ExtensionContext,
        workspaceHash: string,
        outputChannel: vscode.OutputChannel,
        gitBranch: string = "default",
    ) {
        this.context = context;
        this.workspaceHash = workspaceHash;
        this.gitBranch = gitBranch;
        this.outputChannel = outputChannel;
    }

    /**
     * Generate storage key for a snapshot
     */
    private getSnapshotKey(filePath: string): string {
        // Create a unique key based on the absolute path
        const normalizedPath = filePath.replace(/[:\\\/]/g, '_');
        return `recent_edits_snapshot_${this.workspaceHash}_${this.gitBranch}_${normalizedPath}`;
    }

    /**
     * Store a snapshot of a file in VS Code's workspace storage
     */
    async storeSnapshot(filePath: string, content: string, hash: string): Promise<boolean> {
        try {
            const snapshotKey = this.getSnapshotKey(filePath);

            const snapshotInfo: SnapshotInfo = {
                filePath: filePath, // Store absolute path
                hash: hash,
                content: content,
                lastModified: Date.now(),
                gitBranch: this.gitBranch
            };

            // Store in VS Code's workspace storage (hidden from user)
            await this.context.workspaceState.update(snapshotKey, snapshotInfo);

            this.outputChannel.appendLine(`[SnapshotManager] Stored snapshot for: ${filePath}`);
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error storing snapshot for ${filePath}: ${error}`);
            return false;
        }
    }

    /**
     * Retrieve a snapshot of a file from VS Code's workspace storage
     */
    async getSnapshot(filePath: string): Promise<SnapshotInfo | null> {
        try {
            const snapshotKey = this.getSnapshotKey(filePath);
            const snapshot = this.context.workspaceState.get<SnapshotInfo>(snapshotKey);

            if (!snapshot) {
                return null;
            }

            // Verify it's for the correct branch
            if (snapshot.gitBranch !== this.gitBranch) {
                this.outputChannel.appendLine(`[SnapshotManager] Snapshot branch mismatch for ${filePath}: expected ${this.gitBranch}, got ${snapshot.gitBranch}`);
                return null;
            }

            return snapshot;
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error retrieving snapshot for ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Check if a snapshot exists for a file
     */
    hasSnapshot(filePath: string): boolean {
        try {
            const snapshotKey = this.getSnapshotKey(filePath);
            const snapshot = this.context.workspaceState.get<SnapshotInfo>(snapshotKey);
            return !!snapshot && snapshot.gitBranch === this.gitBranch;
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error checking snapshot existence for ${filePath}: ${error}`);
            return false;
        }
    }

    /**
     * Delete a snapshot for a file (when file is deleted)
     */
    async deleteSnapshot(filePath: string): Promise<boolean> {
        try {
            const snapshotKey = this.getSnapshotKey(filePath);
            await this.context.workspaceState.update(snapshotKey, undefined);

            this.outputChannel.appendLine(`[SnapshotManager] Deleted snapshot for: ${filePath}`);
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error deleting snapshot for ${filePath}: ${error}`);
            return false;
        }
    }

    /**
     * Clean up old snapshots for different branches or workspace hashes
     */
    async cleanupOldSnapshots(): Promise<void> {
        try {
            const currentPrefix = `recent_edits_snapshot_${this.workspaceHash}_${this.gitBranch}_`;
            const workspacePrefix = `recent_edits_snapshot_${this.workspaceHash}_`;

            // Get all workspace state keys
            const allKeys = this.context.workspaceState.keys();

            let cleanedCount = 0;
            for (const key of allKeys) {
                // Only process our snapshot keys
                if (key.startsWith('recent_edits_snapshot_')) {
                    // Keep snapshots for current workspace and branch
                    if (!key.startsWith(currentPrefix)) {
                        // If it's from our workspace but different branch, it's old
                        if (key.startsWith(workspacePrefix)) {
                            await this.context.workspaceState.update(key, undefined);
                            cleanedCount++;
                        }
                        // If it's from a different workspace, also clean (stale data)
                        else if (!key.includes(`_${this.workspaceHash}_`)) {
                            await this.context.workspaceState.update(key, undefined);
                            cleanedCount++;
                        }
                    }
                }
            }

            if (cleanedCount > 0) {
                this.outputChannel.appendLine(`[SnapshotManager] Cleaned up ${cleanedCount} old snapshots`);
            }
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error during cleanup: ${error}`);
        }
    }

    /**
     * Get all snapshot files for current workspace and branch
     */
    async getAllSnapshots(): Promise<SnapshotInfo[]> {
        const snapshots: SnapshotInfo[] = [];

        try {
            const currentPrefix = `recent_edits_snapshot_${this.workspaceHash}_${this.gitBranch}_`;
            const allKeys = this.context.workspaceState.keys();

            for (const key of allKeys) {
                if (key.startsWith(currentPrefix)) {
                    const snapshot = this.context.workspaceState.get<SnapshotInfo>(key);
                    if (snapshot) {
                        snapshots.push(snapshot);
                    }
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error getting all snapshots: ${error}`);
        }

        return snapshots;
    }

    /**
     * Update git branch (triggers cleanup)
     */
    updateGitBranch(newBranch: string): void {
        if (this.gitBranch !== newBranch) {
            this.outputChannel.appendLine(`[SnapshotManager] Git branch changed from ${this.gitBranch} to ${newBranch}`);
            this.gitBranch = newBranch;
            // Note: Cleanup will be triggered manually as needed
        }
    }

    /**
     * Get storage statistics for debugging
     */
    async getStorageStats(): Promise<{
        totalSnapshots: number;
        currentBranchSnapshots: number;
        storageKeys: string[];
    }> {
        try {
            const allKeys = this.context.workspaceState.keys();
            const snapshotKeys = allKeys.filter(key => key.startsWith('recent_edits_snapshot_'));
            const currentBranchKeys = snapshotKeys.filter(key =>
                key.startsWith(`recent_edits_snapshot_${this.workspaceHash}_${this.gitBranch}_`)
            );

            return {
                totalSnapshots: snapshotKeys.length,
                currentBranchSnapshots: currentBranchKeys.length,
                storageKeys: snapshotKeys
            };
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error getting storage stats: ${error}`);
            return {
                totalSnapshots: 0,
                currentBranchSnapshots: 0,
                storageKeys: []
            };
        }
    }

    /**
     * Clear all snapshots for current workspace (useful for testing/debugging)
     */
    async clearAllSnapshots(): Promise<void> {
        try {
            const workspacePrefix = `recent_edits_snapshot_${this.workspaceHash}_`;
            const allKeys = this.context.workspaceState.keys();

            let clearedCount = 0;
            for (const key of allKeys) {
                if (key.startsWith(workspacePrefix)) {
                    await this.context.workspaceState.update(key, undefined);
                    clearedCount++;
                }
            }

            this.outputChannel.appendLine(`[SnapshotManager] Cleared ${clearedCount} snapshots for workspace ${this.workspaceHash}`);
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error clearing snapshots: ${error}`);
        }
    }
} 