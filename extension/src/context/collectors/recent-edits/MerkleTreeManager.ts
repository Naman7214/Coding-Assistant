import * as vscode from 'vscode';
import { MerkleTreeBuilder } from '../../../indexing/core/merkle-tree-builder';
import { MerkleTreeNode, TreeComparisonResult } from '../../../indexing/types/chunk';

/**
 * Manages merkle trees for recent edits tracking
 * Provides storage and retrieval using VS Code's workspace storage
 */
export class MerkleTreeManager {
    private merkleBuilder: MerkleTreeBuilder;
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

        // Initialize merkle tree builder with optimized patterns for recent edits
        this.merkleBuilder = new MerkleTreeBuilder(
            [
                // Standard exclusions
                'node_modules/**', '.git/**', '**/.git/**', '**/*.log',
                '**/dist/**', '**/build/**', '**/.DS_Store', '**/thumbs.db',
                '.venv/**', '**/.venv/**', '**/site-packages/**', '**/lib/python*/**',
                '**/bin/**', '**/__pycache__/**', '**/*.pyc',
                // Additional exclusions for recent edits
                '**/.snapshots/**', '**/tmp/**', '**/temp/**', '**/.cache/**'
            ],
            [
                // Include common source code files
                '**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.vue',
                '**/*.py', '**/*.java', '**/*.cpp', '**/*.c', '**/*.h',
                '**/*.cs', '**/*.php', '**/*.rb', '**/*.go', '**/*.rs',
                '**/*.swift', '**/*.kt', '**/*.scala', '**/*.sh',
                '**/*.yaml', '**/*.yml', '**/*.json', '**/*.xml',
                '**/*.md', '**/*.txt', '**/*.sql', '**/*.css', '**/*.scss',
                '**/*.less', '**/*.html', '**/*.htm'
            ],
            this.outputChannel
        );
    }

    /**
     * Build merkle tree for the workspace
     */
    async buildMerkleTree(workspacePath: string): Promise<MerkleTreeNode | null> {
        try {
            const startTime = Date.now();
            this.outputChannel.appendLine(`[MerkleTreeManager] Building merkle tree for: ${workspacePath}`);

            const tree = await this.merkleBuilder.buildTree(workspacePath);
            const duration = Date.now() - startTime;

            this.outputChannel.appendLine(
                `[MerkleTreeManager] Merkle tree built successfully (${duration}ms, hash: ${tree.hash.substring(0, 8)}...)`
            );

            return tree;
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error building merkle tree: ${error}`);
            return null;
        }
    }

    /**
     * Compare two merkle trees and find changes
     */
    compareTreesForChanges(
        oldTree: MerkleTreeNode | null,
        newTree: MerkleTreeNode
    ): TreeComparisonResult {
        try {
            const startTime = Date.now();
            const result = this.merkleBuilder.compareTree(oldTree, newTree);
            const duration = Date.now() - startTime;

            this.outputChannel.appendLine(
                `[MerkleTreeManager] Tree comparison completed (${duration}ms): ` +
                `${result.changedFiles.length} changed, ${result.deletedFiles.length} deleted`
            );

            return result;
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error comparing trees: ${error}`);
            return { changedFiles: [], deletedFiles: [] };
        }
    }

    /**
     * Store merkle tree in VS Code workspace storage
     */
    async storeMerkleTree(tree: MerkleTreeNode, gitBranch: string): Promise<void> {
        try {
            const key = this.generateStorageKey(gitBranch);

            // Serialize with compression-friendly format
            const serializedTree = this.serializeMerkleTree(tree);

            await this.context.workspaceState.update(key, serializedTree);

            this.outputChannel.appendLine(
                `[MerkleTreeManager] Stored merkle tree for branch '${gitBranch}' ` +
                `(${this.formatBytes(JSON.stringify(serializedTree).length)})`
            );
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error storing merkle tree: ${error}`);
            throw error;
        }
    }

    /**
     * Retrieve merkle tree from VS Code workspace storage
     */
    async retrieveMerkleTree(gitBranch: string): Promise<MerkleTreeNode | null> {
        try {
            const key = this.generateStorageKey(gitBranch);
            const serializedTree = this.context.workspaceState.get<any>(key);

            if (!serializedTree) {
                this.outputChannel.appendLine(`[MerkleTreeManager] No stored merkle tree found for branch '${gitBranch}'`);
                return null;
            }

            const tree = this.deserializeMerkleTree(serializedTree);

            this.outputChannel.appendLine(
                `[MerkleTreeManager] Retrieved merkle tree for branch '${gitBranch}' ` +
                `(hash: ${tree.hash.substring(0, 8)}...)`
            );

            return tree;
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error retrieving merkle tree: ${error}`);
            return null;
        }
    }

    /**
     * Clean up old merkle trees for branches that no longer exist
     */
    async cleanupOldTrees(currentBranch: string, existingBranches: string[]): Promise<void> {
        try {
            const allKeys = this.context.workspaceState.keys();
            const prefix = `recent_changes_merkle_tree_${this.workspaceHash}_`;

            let cleanedCount = 0;

            for (const key of allKeys) {
                if (key.startsWith(prefix)) {
                    const branch = key.substring(prefix.length);

                    // Keep current branch and any existing branches
                    if (branch !== currentBranch && !existingBranches.includes(branch)) {
                        await this.context.workspaceState.update(key, undefined);
                        cleanedCount++;
                        this.outputChannel.appendLine(`[MerkleTreeManager] Cleaned up tree for deleted branch: ${branch}`);
                    }
                }
            }

            if (cleanedCount > 0) {
                this.outputChannel.appendLine(`[MerkleTreeManager] Cleaned up ${cleanedCount} old merkle trees`);
            }
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error during cleanup: ${error}`);
        }
    }

    /**
     * Generate storage key for merkle tree
     */
    private generateStorageKey(gitBranch: string): string {
        return `recent_changes_merkle_tree_${this.workspaceHash}_${gitBranch}`;
    }

    /**
     * Serialize merkle tree for storage (memory-efficient format)
     */
    private serializeMerkleTree(tree: MerkleTreeNode): any {
        const serialize = (node: MerkleTreeNode): any => {
            const serialized: any = {
                h: node.hash,          // hash
                p: node.filePath,      // path
                m: node.lastModified,  // modified time
                s: node.fileSize       // size
            };

            // Only include children if they exist (saves space)
            if (node.children && node.children.length > 0) {
                serialized.c = node.children.map(serialize);
            }

            return serialized;
        };

        return {
            version: '1.0',
            timestamp: Date.now(),
            tree: serialize(tree)
        };
    }

    /**
     * Deserialize merkle tree from storage
     */
    private deserializeMerkleTree(serialized: any): MerkleTreeNode {
        if (!serialized || serialized.version !== '1.0') {
            throw new Error('Invalid or incompatible merkle tree format');
        }

        const deserialize = (node: any): MerkleTreeNode => {
            const result: MerkleTreeNode = {
                hash: node.h,
                filePath: node.p,
                lastModified: node.m,
                fileSize: node.s
            };

            if (node.c && Array.isArray(node.c)) {
                result.children = node.c.map(deserialize);
            }

            return result;
        };

        return deserialize(serialized.tree);
    }

    /**
     * Format bytes for logging
     */
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Get storage statistics
     */
    async getStorageStats(): Promise<{
        totalTrees: number;
        totalSize: number;
        branches: string[];
    }> {
        try {
            const allKeys = this.context.workspaceState.keys();
            const prefix = `recent_changes_merkle_tree_${this.workspaceHash}_`;

            let totalSize = 0;
            const branches: string[] = [];

            for (const key of allKeys) {
                if (key.startsWith(prefix)) {
                    const branch = key.substring(prefix.length);
                    branches.push(branch);

                    const data = this.context.workspaceState.get(key);
                    if (data) {
                        totalSize += JSON.stringify(data).length;
                    }
                }
            }

            return {
                totalTrees: branches.length,
                totalSize,
                branches
            };
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error getting storage stats: ${error}`);
            return { totalTrees: 0, totalSize: 0, branches: [] };
        }
    }
}
