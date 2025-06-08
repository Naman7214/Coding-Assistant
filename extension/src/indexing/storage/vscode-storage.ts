import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { IndexingConfig, MerkleTreeNode } from '../types/chunk';

export class VSCodeStorageManager {
    private context: vscode.ExtensionContext;
    private workspaceHash: string;

    constructor(context: vscode.ExtensionContext, workspaceHash: string) {
        this.context = context;
        this.workspaceHash = workspaceHash;
    }

    /**
     * Save merkle tree to VSCode storage
     */
    async saveMerkleTree(merkleTree: MerkleTreeNode): Promise<void> {
        try {
            const key = `merkle_tree_${this.workspaceHash}`;
            const serialized = JSON.stringify(merkleTree);

            // For large trees, save to file system storage
            if (serialized.length > 1024 * 1024) { // 1MB threshold
                await this.saveToFileStorage(key, serialized);
            } else {
                // For smaller trees, use VSCode's built-in storage
                await this.context.globalState.update(key, merkleTree);
            }
        } catch (error) {
            console.error('Error saving merkle tree:', error);
            throw error;
        }
    }

    /**
     * Load merkle tree from VSCode storage
     */
    async loadMerkleTree(): Promise<MerkleTreeNode | null> {
        try {
            const key = `merkle_tree_${this.workspaceHash}`;

            // Try to load from file storage first
            const fromFile = await this.loadFromFileStorage(key);
            if (fromFile) {
                return JSON.parse(fromFile as string);
            }

            // Fallback to VSCode storage
            const fromVSCode = this.context.globalState.get<MerkleTreeNode>(key);
            return fromVSCode || null;
        } catch (error) {
            console.error('Error loading merkle tree:', error);
            return null;
        }
    }

    /**
     * Save indexing configuration
     */
    async saveConfig(config: IndexingConfig): Promise<void> {
        try {
            const key = `indexing_config_${this.workspaceHash}`;
            await this.context.globalState.update(key, config);
        } catch (error) {
            console.error('Error saving indexing config:', error);
            throw error;
        }
    }

    /**
     * Load indexing configuration
     */
    async loadConfig(): Promise<IndexingConfig | null> {
        try {
            const key = `indexing_config_${this.workspaceHash}`;
            return this.context.globalState.get<IndexingConfig>(key) || null;
        } catch (error) {
            console.error('Error loading indexing config:', error);
            return null;
        }
    }

    // Removed chunk storage methods - chunks are sent directly to server

    /**
     * Get storage statistics
     */
    async getStorageStats(): Promise<{
        merkleTreeSize: number;
        configSize: number;
        totalStorageSize: number;
    }> {
        try {
            const storageDir = this.getStorageDirectory();
            let totalSize = 0;

            if (await this.directoryExists(storageDir)) {
                const files = await fs.promises.readdir(storageDir);

                for (const file of files) {
                    const filePath = path.join(storageDir, file);
                    const stats = await fs.promises.stat(filePath);
                    totalSize += stats.size;
                }
            }

            // Estimate sizes from VSCode storage
            const merkleTree = await this.loadMerkleTree();
            const config = await this.loadConfig();

            const merkleTreeSize = merkleTree ? JSON.stringify(merkleTree).length : 0;
            const configSize = config ? JSON.stringify(config).length : 0;

            return {
                merkleTreeSize,
                configSize,
                totalStorageSize: totalSize
            };
        } catch (error) {
            console.error('Error getting storage stats:', error);
            return {
                merkleTreeSize: 0,
                configSize: 0,
                totalStorageSize: 0
            };
        }
    }

    /**
     * Save data to file system storage
     */
    private async saveToFileStorage(key: string, data: string | Buffer, isBinary: boolean = false): Promise<string> {
        const storageDir = this.getStorageDirectory();
        await this.ensureDirectoryExists(storageDir);

        const filePath = path.join(storageDir, key);

        if (isBinary) {
            await fs.promises.writeFile(filePath, data as Buffer);
        } else {
            await fs.promises.writeFile(filePath, data as string, 'utf-8');
        }

        return filePath;
    }

    /**
     * Load data from file system storage
     */
    private async loadFromFileStorage(key: string, isBinary: boolean = false): Promise<string | Buffer | null> {
        try {
            const storageDir = this.getStorageDirectory();
            const filePath = path.join(storageDir, key);

            if (!await this.fileExists(filePath)) {
                return null;
            }

            if (isBinary) {
                return await fs.promises.readFile(filePath);
            } else {
                return await fs.promises.readFile(filePath, 'utf-8');
            }
        } catch (error) {
            return null;
        }
    }

    /**
     * Get storage directory path
     */
    private getStorageDirectory(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'indexing');
    }

    /**
     * Compress data using gzip
     */
    private async compressData(data: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            zlib.gzip(Buffer.from(data, 'utf-8'), (error, compressed) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(compressed);
                }
            });
        });
    }

    /**
     * Decompress gzipped data
     */
    private async decompressData(compressed: Buffer): Promise<string> {
        return new Promise((resolve, reject) => {
            zlib.gunzip(compressed, (error, decompressed) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(decompressed.toString('utf-8'));
                }
            });
        });
    }

    /**
     * Ensure directory exists
     */
    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            await fs.promises.access(dirPath);
        } catch {
            await fs.promises.mkdir(dirPath, { recursive: true });
        }
    }

    /**
     * Check if directory exists
     */
    private async directoryExists(dirPath: string): Promise<boolean> {
        try {
            const stats = await fs.promises.stat(dirPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Check if file exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            const stats = await fs.promises.stat(filePath);
            return stats.isFile();
        } catch {
            return false;
        }
    }
} 