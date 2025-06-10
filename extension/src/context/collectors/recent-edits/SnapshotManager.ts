import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SnapshotInfo } from '../../types/collectors';

/**
 * Manages file snapshots for diff comparison
 * Uses VS Code's workspace storage for invisible, serialized storage
 */
export class SnapshotManager {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private workspaceHash: string;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        workspaceHash: string
    ) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.workspaceHash = workspaceHash;
    }

    /**
     * Store file snapshot in VS Code workspace storage (serialized)
     */
    async storeSnapshot(
        filePath: string,
        content: string,
        gitBranch: string
    ): Promise<void> {
        try {
            const key = this.generateSnapshotKey(filePath, gitBranch);

            // Create serialized snapshot for memory efficiency
            const snapshot: SnapshotInfo = {
                filePath,
                hash: this.hashContent(content),
                content: this.compressContent(content),
                lastModified: Date.now(),
                gitBranch
            };

            const serializedSnapshot = this.serializeSnapshot(snapshot);

            await this.context.workspaceState.update(key, serializedSnapshot);

            this.outputChannel.appendLine(
                `[SnapshotManager] Stored snapshot for ${path.basename(filePath)} ` +
                `on branch '${gitBranch}' (${this.formatBytes(content.length)} → ` +
                `${this.formatBytes(JSON.stringify(serializedSnapshot).length)})`
            );
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error storing snapshot for ${filePath}: ${error}`);
            throw error;
        }
    }

    /**
     * Retrieve file snapshot from VS Code workspace storage
     */
    async retrieveSnapshot(filePath: string, gitBranch: string): Promise<string | null> {
        try {
            const key = this.generateSnapshotKey(filePath, gitBranch);
            const serializedSnapshot = this.context.workspaceState.get<any>(key);

            if (!serializedSnapshot) {
                return null;
            }

            const snapshot = this.deserializeSnapshot(serializedSnapshot);
            const content = this.decompressContent(snapshot.content);

            this.outputChannel.appendLine(
                `[SnapshotManager] Retrieved snapshot for ${path.basename(filePath)} ` +
                `on branch '${gitBranch}' (${this.formatBytes(content.length)})`
            );

            return content;
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error retrieving snapshot for ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Store snapshots for multiple files (batch operation)
     */
    async storeMultipleSnapshots(
        filePaths: string[],
        gitBranch: string
    ): Promise<{ success: string[], failed: string[] }> {
        const success: string[] = [];
        const failed: string[] = [];

        this.outputChannel.appendLine(
            `[SnapshotManager] Storing snapshots for ${filePaths.length} files on branch '${gitBranch}'`
        );

        for (const filePath of filePaths) {
            try {
                const content = await this.readFileContent(filePath);
                if (content !== null) {
                    await this.storeSnapshot(filePath, content, gitBranch);
                    success.push(filePath);
                } else {
                    failed.push(filePath);
                }
            } catch (error) {
                this.outputChannel.appendLine(`[SnapshotManager] Failed to store snapshot for ${filePath}: ${error}`);
                failed.push(filePath);
            }
        }

        this.outputChannel.appendLine(
            `[SnapshotManager] Batch snapshot operation completed: ${success.length} success, ${failed.length} failed`
        );

        return { success, failed };
    }

    /**
     * Check if snapshot exists for a file
     */
    async hasSnapshot(filePath: string, gitBranch: string): Promise<boolean> {
        try {
            const key = this.generateSnapshotKey(filePath, gitBranch);
            return this.context.workspaceState.get(key) !== undefined;
        } catch (error) {
            return false;
        }
    }

    /**
     * Delete snapshot for a file
     */
    async deleteSnapshot(filePath: string, gitBranch: string): Promise<void> {
        try {
            const key = this.generateSnapshotKey(filePath, gitBranch);
            await this.context.workspaceState.update(key, undefined);

            this.outputChannel.appendLine(
                `[SnapshotManager] Deleted snapshot for ${path.basename(filePath)} on branch '${gitBranch}'`
            );
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error deleting snapshot for ${filePath}: ${error}`);
            throw error;
        }
    }

    /**
     * Clean up snapshots for files that no longer exist or for old branches
     */
    async cleanupSnapshots(
        currentBranch: string,
        existingBranches: string[],
        existingFiles?: string[]
    ): Promise<void> {
        try {
            const allKeys = this.context.workspaceState.keys();
            const prefix = `recent_edits_snapshot_${this.workspaceHash}_`;

            let cleanedCount = 0;
            const startTime = Date.now();

            for (const key of allKeys) {
                if (key.startsWith(prefix)) {
                    const keyParts = key.substring(prefix.length).split('_');
                    if (keyParts.length >= 1) {
                        const branch = keyParts[0];

                        // Extract file path from the remaining parts
                        const normalizedPath = keyParts.slice(1).join('_');
                        const originalPath = this.denormalizeFilePath(normalizedPath);

                        let shouldDelete = false;

                        // Delete snapshots for branches that no longer exist
                        if (branch !== currentBranch && !existingBranches.includes(branch)) {
                            shouldDelete = true;
                        }

                        // Delete snapshots for files that no longer exist (if file list provided)
                        if (existingFiles && originalPath && !existingFiles.includes(originalPath)) {
                            shouldDelete = true;
                        }

                        if (shouldDelete) {
                            await this.context.workspaceState.update(key, undefined);
                            cleanedCount++;
                        }
                    }
                }
            }

            const duration = Date.now() - startTime;

            if (cleanedCount > 0) {
                this.outputChannel.appendLine(
                    `[SnapshotManager] Cleaned up ${cleanedCount} old snapshots (${duration}ms)`
                );
            }
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error during cleanup: ${error}`);
        }
    }

    /**
     * Get snapshot storage statistics
     */
    async getStorageStats(): Promise<{
        totalSnapshots: number;
        totalSize: number;
        snapshotsByBranch: Record<string, number>;
        oldestSnapshot: number;
        newestSnapshot: number;
    }> {
        try {
            const allKeys = this.context.workspaceState.keys();
            const prefix = `recent_edits_snapshot_${this.workspaceHash}_`;

            let totalSnapshots = 0;
            let totalSize = 0;
            let oldestSnapshot = Date.now();
            let newestSnapshot = 0;
            const snapshotsByBranch: Record<string, number> = {};

            for (const key of allKeys) {
                if (key.startsWith(prefix)) {
                    totalSnapshots++;

                    const data = this.context.workspaceState.get(key);
                    if (data) {
                        const size = JSON.stringify(data).length;
                        totalSize += size;

                        // Extract branch from key
                        const keyParts = key.substring(prefix.length).split('_');
                        if (keyParts.length >= 1) {
                            const branch = keyParts[0];
                            snapshotsByBranch[branch] = (snapshotsByBranch[branch] || 0) + 1;
                        }

                        // Track snapshot age if it's a proper serialized snapshot
                        if (typeof data === 'object' && data !== null && 'ts' in data && typeof (data as any).ts === 'number') {
                            const timestamp = (data as any).ts;
                            oldestSnapshot = Math.min(oldestSnapshot, timestamp);
                            newestSnapshot = Math.max(newestSnapshot, timestamp);
                        }
                    }
                }
            }

            return {
                totalSnapshots,
                totalSize,
                snapshotsByBranch,
                oldestSnapshot: oldestSnapshot === Date.now() ? 0 : oldestSnapshot,
                newestSnapshot
            };
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error getting storage stats: ${error}`);
            return {
                totalSnapshots: 0,
                totalSize: 0,
                snapshotsByBranch: {},
                oldestSnapshot: 0,
                newestSnapshot: 0
            };
        }
    }

    /**
     * Read file content from disk
     */
    private async readFileContent(filePath: string): Promise<string | null> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            return content;
        } catch (error) {
            this.outputChannel.appendLine(`[SnapshotManager] Error reading file ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Generate storage key for snapshot
     */
    private generateSnapshotKey(filePath: string, gitBranch: string): string {
        const normalizedPath = this.normalizeFilePath(filePath);
        return `recent_edits_snapshot_${this.workspaceHash}_${gitBranch}_${normalizedPath}`;
    }

    /**
     * Normalize file path for use as storage key (handle special characters)
     */
    private normalizeFilePath(filePath: string): string {
        // Replace path separators and special characters with underscores
        return filePath
            .replace(/[\/\\:*?"<>|]/g, '_')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }

    /**
     * Attempt to denormalize file path (for cleanup purposes)
     */
    private denormalizeFilePath(normalizedPath: string): string {
        // This is a best-effort conversion back - not perfect but sufficient for cleanup
        return normalizedPath.replace(/_/g, '/');
    }

    /**
     * Hash content for integrity checking
     */
    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
    }

    /**
     * Compress content for storage (simple run-length encoding for text)
     */
    private compressContent(content: string): string {
        // For very small files, don't compress
        if (content.length < 100) {
            return content;
        }

        try {
            // Simple compression: remove excessive whitespace and line endings
            const compressed = content
                .replace(/\n\s*\n\s*\n/g, '\n\n')  // Reduce multiple empty lines
                .replace(/[ \t]+/g, ' ')           // Reduce multiple spaces/tabs
                .trim();

            // Only use compressed version if it's significantly smaller
            if (compressed.length < content.length * 0.8) {
                return `__COMPRESSED__${compressed}`;
            }

            return content;
        } catch (error) {
            // If compression fails, return original content
            return content;
        }
    }

    /**
     * Decompress content after retrieval
     */
    private decompressContent(content: string): string {
        if (content.startsWith('__COMPRESSED__')) {
            return content.substring('__COMPRESSED__'.length);
        }
        return content;
    }

    /**
     * Serialize snapshot for storage (memory-efficient format)
     */
    private serializeSnapshot(snapshot: SnapshotInfo): any {
        return {
            v: '1.0',                    // version
            p: snapshot.filePath,        // path
            h: snapshot.hash,            // hash
            c: snapshot.content,         // content (possibly compressed)
            m: snapshot.lastModified,    // modified time
            b: snapshot.gitBranch,       // branch
            ts: Date.now()               // timestamp when stored
        };
    }

    /**
     * Deserialize snapshot from storage
     */
    private deserializeSnapshot(serialized: any): SnapshotInfo {
        if (!serialized || serialized.v !== '1.0') {
            throw new Error('Invalid or incompatible snapshot format');
        }

        return {
            filePath: serialized.p,
            hash: serialized.h,
            content: serialized.c,
            lastModified: serialized.m,
            gitBranch: serialized.b
        };
    }

    /**
     * Format bytes for logging
     */
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';

        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}
