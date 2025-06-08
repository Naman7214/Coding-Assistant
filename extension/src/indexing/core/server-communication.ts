import axios from 'axios';
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { CodeChunk } from '../types/chunk';
import { obfuscatePath } from '../utils/hash';

export interface ServerConfig {
    baseUrl: string;
    apiKey?: string;
    timeout: number;
}

export interface ChunkUploadResponse {
    success: boolean;
    processedChunks: number;
    skippedChunks: number;
    errors: string[];
    processingTime: number;
}

export class ServerCommunication {
    private config: ServerConfig;
    private workspaceHash: string;

    constructor(workspaceHash: string, config: ServerConfig) {
        this.workspaceHash = workspaceHash;
        this.config = {
            baseUrl: config.baseUrl || 'http://localhost:8000',
            apiKey: config.apiKey,
            timeout: config.timeout || 30000
        };
    }

    /**
     * Send compressed chunks to server
     */
    async sendChunksToServer(chunks: CodeChunk[], deletedFilesPaths: string[] = [], currentGitBranch: string = 'default'): Promise<ChunkUploadResponse> {
        try {
            console.log(`Sending ${chunks.length} chunks to server...`);
            if (deletedFilesPaths.length > 0) {
                console.log(`Including ${deletedFilesPaths.length} deleted files in payload for branch: ${currentGitBranch}`);
            }

            // Convert deleted file paths to obfuscated paths
            const deletedObfuscatedPaths = deletedFilesPaths.map(filePath => {
                return obfuscatePath(filePath, this.workspaceHash);
            });

            const payload = {
                workspace_hash: this.workspaceHash,
                chunks: chunks,
                deleted_files_obfuscated_paths: deletedObfuscatedPaths,
                current_git_branch: currentGitBranch,
                timestamp: Date.now()
            };
            console.log(`Payload being sent to server:`, payload);

            // Convert payload to JSON string
            const jsonPayload = JSON.stringify(payload);

            // Compress the JSON payload with gzip
            const compressedPayload = await this.compressWithGzip(jsonPayload);

            const response = await axios.post(
                `${this.config.baseUrl}/api/v1/index-workspace-chunks`,
                compressedPayload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Encoding': 'gzip',
                        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
                    },
                    timeout: 30 * 60 * 1000 // 30 minutes
                }
            );

            if (response.status === 200) {
                console.log('Successfully sent chunks to server');
                return response.data;
            } else {
                throw new Error(`Server responded with status ${response.status}`);
            }

        } catch (error) {
            console.error('Error sending chunks to server:', error);

            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to send chunks: ${error.message}`);
            }

            throw error;
        }
    }

    /**
     * Compress data using gzip
     */
    private async compressWithGzip(data: string): Promise<Buffer> {
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
     * Check server health and connectivity
     */
    async checkServerHealth(): Promise<boolean> {
        try {
            const response = await axios.get(
                `${this.config.baseUrl}/api/health`,
                {
                    timeout: 5000,
                    headers: {
                        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
                    }
                }
            );

            return response.status === 200;
        } catch (error) {
            console.warn('Server health check failed:', error);
            return false;
        }
    }

    /**
     * Get server indexing status for workspace
     */
    async getIndexingStatus(): Promise<{
        workspaceHash: string;
        lastUpdate: number;
        totalChunks: number;
        status: 'active' | 'idle' | 'error';
    } | null> {
        try {
            const response = await axios.get(
                `${this.config.baseUrl}/api/indexing/status/${this.workspaceHash}`,
                {
                    headers: {
                        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
                    },
                    timeout: 10000
                }
            );

            if (response.status === 200) {
                return response.data;
            }

            return null;
        } catch (error) {
            console.warn('Failed to get indexing status:', error);
            return null;
        }
    }

    /**
     * Request server to delete workspace data
     */
    async deleteWorkspaceData(): Promise<boolean> {
        try {
            const response = await axios.delete(
                `${this.config.baseUrl}/api/indexing/workspace/${this.workspaceHash}`,
                {
                    headers: {
                        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
                    },
                    timeout: 15000
                }
            );

            return response.status === 200;
        } catch (error) {
            console.error('Error deleting workspace data:', error);
            return false;
        }
    }

    /**
     * Update server configuration
     */
    updateConfig(newConfig: Partial<ServerConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Get current configuration
     */
    getConfig(): ServerConfig {
        return { ...this.config };
    }
}

/**
 * Create server communication instance from VSCode settings
 */
export function createServerCommunicationFromSettings(
    workspaceHash: string
): ServerCommunication {
    const config = vscode.workspace.getConfiguration('codingAgent.indexing');

    const serverConfig: ServerConfig = {
        baseUrl: config.get('serverUrl') || 'http://localhost:8000',
        apiKey: config.get('apiKey'),
        timeout: config.get('timeout') || 30000
    };

    return new ServerCommunication(workspaceHash, serverConfig);
} 