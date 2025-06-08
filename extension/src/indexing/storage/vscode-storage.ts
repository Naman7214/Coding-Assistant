import * as vscode from 'vscode';
import { IndexingConfig, MerkleTreeNode } from '../types/chunk';

export class VSCodeStorageManager {
    private context: vscode.ExtensionContext;
    private workspaceHash: string;

    constructor(context: vscode.ExtensionContext, workspaceHash: string) {
        this.context = context;
        this.workspaceHash = workspaceHash;
    }

    /**
     * Save merkle tree for a specific branch to VSCode storage
     */
    async saveMerkleTree(merkleTree: MerkleTreeNode, gitBranch: string): Promise<void> {
        try {
            const key = `merkle_tree_${this.workspaceHash}_${gitBranch}`;
            await this.context.globalState.update(key, merkleTree);
        } catch (error) {
            console.error('Error saving branch-specific merkle tree:', error);
            throw error;
        }
    }

    /**
     * Load merkle tree for a specific branch from VSCode storage
     */
    async loadMerkleTree(gitBranch: string): Promise<MerkleTreeNode | null> {
        try {
            const key = `merkle_tree_${this.workspaceHash}_${gitBranch}`;
            const merkleTree = this.context.globalState.get<MerkleTreeNode>(key);
            return merkleTree || null;
        } catch (error) {
            console.error('Error loading branch-specific merkle tree:', error);
            return null;
        }
    }

    /**
     * Delete merkle tree for a specific branch
     */
    async deleteMerkleTree(gitBranch: string): Promise<void> {
        try {
            const key = `merkle_tree_${this.workspaceHash}_${gitBranch}`;
            await this.context.globalState.update(key, undefined);
        } catch (error) {
            console.error('Error deleting branch-specific merkle tree:', error);
            throw error;
        }
    }

    /**
     * Get all stored branches for this workspace
     */
    async getStoredBranches(): Promise<string[]> {
        try {
            const keys = this.context.globalState.keys();
            const prefix = `merkle_tree_${this.workspaceHash}_`;

            return keys
                .filter(key => key.startsWith(prefix))
                .map(key => key.replace(prefix, ''));
        } catch (error) {
            console.error('Error getting stored branches:', error);
            return [];
        }
    }

    /**
     * Save indexing configuration for a specific branch
     */
    async saveConfig(config: IndexingConfig): Promise<void> {
        try {
            const key = `indexing_config_${this.workspaceHash}_${config.gitBranch}`;
            await this.context.globalState.update(key, config);
        } catch (error) {
            console.error('Error saving branch-specific indexing config:', error);
            throw error;
        }
    }

    /**
     * Load indexing configuration for a specific branch
     */
    async loadConfig(gitBranch: string): Promise<IndexingConfig | null> {
        try {
            const key = `indexing_config_${this.workspaceHash}_${gitBranch}`;
            return this.context.globalState.get<IndexingConfig>(key) || null;
        } catch (error) {
            console.error('Error loading branch-specific indexing config:', error);
            return null;
        }
    }

    /**
     * Get storage statistics for all branches
     */
    async getStorageStats(): Promise<{
        totalBranches: number;
        merkleTreesSize: number;
        configsSize: number;
        branches: string[];
    }> {
        try {
            const branches = await this.getStoredBranches();
            let merkleTreesSize = 0;
            let configsSize = 0;

            for (const branch of branches) {
                const merkleTree = await this.loadMerkleTree(branch);
                const config = await this.loadConfig(branch);

                if (merkleTree) {
                    merkleTreesSize += JSON.stringify(merkleTree).length;
                }
                if (config) {
                    configsSize += JSON.stringify(config).length;
                }
            }

            return {
                totalBranches: branches.length,
                merkleTreesSize,
                configsSize,
                branches
            };
        } catch (error) {
            console.error('Error getting storage stats:', error);
            return {
                totalBranches: 0,
                merkleTreesSize: 0,
                configsSize: 0,
                branches: []
            };
        }
    }

    /**
     * Clean up old branch data (for branches that no longer exist)
     */
    async cleanupOldBranches(activeBranches: string[]): Promise<void> {
        try {
            const storedBranches = await this.getStoredBranches();
            const branchesToDelete = storedBranches.filter(branch => !activeBranches.includes(branch));

            for (const branch of branchesToDelete) {
                await this.deleteMerkleTree(branch);

                // Also delete config for that branch
                const configKey = `indexing_config_${this.workspaceHash}_${branch}`;
                await this.context.globalState.update(configKey, undefined);
            }

            if (branchesToDelete.length > 0) {
                console.log(`Cleaned up data for ${branchesToDelete.length} old branches: ${branchesToDelete.join(', ')}`);
            }
        } catch (error) {
            console.error('Error cleaning up old branches:', error);
        }
    }
} 