import * as vscode from 'vscode';
import { MerkleTreeBuilder } from '../../../indexing/core/merkle-tree-builder';
import { MerkleTreeNode, TreeComparisonResult } from '../../../indexing/types/chunk';

export class MerkleTreeManager {
    private merkleTreeBuilder: MerkleTreeBuilder;
    private outputChannel: vscode.OutputChannel;
    private workspacePath: string;

    constructor(workspacePath: string, outputChannel: vscode.OutputChannel) {
        this.workspacePath = workspacePath;
        this.outputChannel = outputChannel;
        this.merkleTreeBuilder = new MerkleTreeBuilder(
            [], // Use default exclude patterns
            [], // Use default include patterns
            outputChannel
        );
    }

    /**
     * Build current merkle tree for the workspace
     */
    async buildCurrentTree(): Promise<MerkleTreeNode> {
        try {
            this.outputChannel.appendLine('[MerkleTreeManager] Building current merkle tree...');
            const tree = await this.merkleTreeBuilder.buildTree(this.workspacePath);
            this.outputChannel.appendLine(`[MerkleTreeManager] Built tree with hash: ${tree.hash}`);
            return tree;
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error building merkle tree: ${error}`);
            throw error;
        }
    }

    /**
     * Compare two merkle trees and get changed/deleted files
     */
    compareTree(oldTree: MerkleTreeNode | null, newTree: MerkleTreeNode): TreeComparisonResult {
        try {
            const result = this.merkleTreeBuilder.compareTree(oldTree, newTree);

            this.outputChannel.appendLine(
                `[MerkleTreeManager] Tree comparison: ${result.changedFiles.length} changed, ${result.deletedFiles.length} deleted`
            );

            return result;
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error comparing trees: ${error}`);
            return { changedFiles: [], deletedFiles: [] };
        }
    }

    /**
     * Get all files from a merkle tree (for new files detection)
     */
    getAllFilesFromTree(tree: MerkleTreeNode): string[] {
        const files: string[] = [];
        this.collectFiles(tree, files);
        return files;
    }

    /**
     * Recursively collect all file paths from a merkle tree node
     */
    private collectFiles(node: MerkleTreeNode, files: string[]): void {
        if (!node.children) {
            // It's a file
            files.push(node.filePath);
        } else {
            // It's a directory, recurse into children
            for (const child of node.children) {
                this.collectFiles(child, files);
            }
        }
    }

    /**
     * Check if trees are identical
     */
    areTreesIdentical(tree1: MerkleTreeNode | null, tree2: MerkleTreeNode | null): boolean {
        if (!tree1 && !tree2) {
            return true;
        }
        if (!tree1 || !tree2) {
            return false;
        }
        return tree1.hash === tree2.hash;
    }

    /**
     * Serialize merkle tree for storage
     */
    serializeTree(tree: MerkleTreeNode): string {
        try {
            return JSON.stringify(tree, null, 2);
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error serializing tree: ${error}`);
            return '{}';
        }
    }

    /**
     * Deserialize merkle tree from storage
     */
    deserializeTree(treeData: string): MerkleTreeNode | null {
        try {
            return JSON.parse(treeData) as MerkleTreeNode;
        } catch (error) {
            this.outputChannel.appendLine(`[MerkleTreeManager] Error deserializing tree: ${error}`);
            return null;
        }
    }

    /**
     * Get detailed file information from a merkle tree node
     */
    getFileInfo(tree: MerkleTreeNode, filePath: string): {
        hash: string;
        lastModified: number;
        fileSize: number;
    } | null {
        const fileNode = this.findFileNode(tree, filePath);
        if (fileNode) {
            return {
                hash: fileNode.hash,
                lastModified: fileNode.lastModified,
                fileSize: fileNode.fileSize
            };
        }
        return null;
    }

    /**
     * Find a specific file node in the merkle tree
     */
    private findFileNode(node: MerkleTreeNode, targetPath: string): MerkleTreeNode | null {
        if (node.filePath === targetPath) {
            return node;
        }

        if (node.children) {
            for (const child of node.children) {
                const found = this.findFileNode(child, targetPath);
                if (found) {
                    return found;
                }
            }
        }

        return null;
    }

    /**
     * Get statistics about the merkle tree
     */
    getTreeStats(tree: MerkleTreeNode): {
        totalFiles: number;
        totalDirectories: number;
        totalSize: number;
    } {
        let totalFiles = 0;
        let totalDirectories = 0;
        let totalSize = 0;

        const collectStats = (node: MerkleTreeNode) => {
            if (node.children) {
                totalDirectories++;
                for (const child of node.children) {
                    collectStats(child);
                }
            } else {
                totalFiles++;
                totalSize += node.fileSize;
            }
        };

        collectStats(tree);

        return {
            totalFiles,
            totalDirectories,
            totalSize
        };
    }
} 