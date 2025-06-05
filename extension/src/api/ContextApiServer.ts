import cors from 'cors';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { PersistentTerminalManager } from '../bridge/PersistentTerminalManager';
import { ContextManager } from '../context/ContextManager';
import { VSCodeStorage } from '../context/storage/VSCodeStorage';

interface StreamingChunk {
    id: string;
    type: 'workspace' | 'activeFile' | 'openFiles' | 'projectStructure' | 'gitContext' | 'complete';
    data: any;
    chunkIndex: number;
    totalChunks: number;
    workspaceId: string;
}

interface TerminalRequest {
    command: string;
    workspacePath: string;
    workingDirectory?: string;
    environmentVariables?: Record<string, string>;
    isBackground?: boolean;
    timeout?: number;
    operationType: 'terminal_command' | 'read_file' | 'write_file' | 'list_directory' | 'delete_file' | 'search_files';
    // Additional parameters for file operations
    filePath?: string;
    content?: string;
    startLine?: number;
    endLine?: number;
    searchPattern?: string;
    directoryPath?: string;
}

interface TerminalResponse {
    success: boolean;
    data?: any;
    error?: string;
    timestamp: string;
    workspacePath: string;
    operationType: string;
}

export class ContextApiServer implements vscode.Disposable {
    private app: express.Application;
    private server: http.Server | null = null;
    private port: number = 3001;
    private readonly outputChannel: vscode.OutputChannel;
    private isRunning: boolean = false;
    private terminalManager: PersistentTerminalManager;

    constructor(
        private storage: VSCodeStorage,
        private contextManager: ContextManager,
        outputChannel: vscode.OutputChannel
    ) {
        this.outputChannel = outputChannel;
        this.terminalManager = new PersistentTerminalManager(outputChannel);
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        this.app.use(cors({
            origin: ['http://localhost:5000', 'http://localhost:5001', 'http://0.0.0.0:5000', 'http://0.0.0.0:5001', 'http://localhost:8001'],
            credentials: true
        }));

        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

        // Request logging middleware
        this.app.use((req, res, next) => {
            this.outputChannel.appendLine(`[UnifiedAPI] ${req.method} ${req.path} - ${req.ip}`);
            next();
        });

        // Error handling middleware
        this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
            this.outputChannel.appendLine(`[UnifiedAPI] Error: ${error.message}`);
            res.status(500).json({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        });
    }

    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/api/health', this.handleHealthCheck.bind(this));

        // Context API routes
        // Streaming context endpoint (main endpoint for coding agent)
        this.app.get('/api/workspace/:workspaceId/context/stream', this.handleStreamingContext.bind(this));

        // Legacy context endpoint (fallback)
        this.app.get('/api/workspace/:workspaceId/context', this.handleLegacyContext.bind(this));

        // Workspace metadata endpoint
        this.app.get('/api/workspace/:workspaceId/metadata', this.handleWorkspaceMetadata.bind(this));

        // File content endpoint (on-demand)
        this.app.get('/api/workspace/:workspaceId/files/content', this.handleFileContent.bind(this));

        // Workspace stats endpoint
        this.app.get('/api/workspace/:workspaceId/stats', this.handleWorkspaceStats.bind(this));

        // Force context collection endpoint
        this.app.post('/api/workspace/:workspaceId/collect', this.handleForceCollection.bind(this));

        // Terminal Bridge API routes
        // Main terminal bridge endpoint - single endpoint for all operations
        this.app.post('/api/terminal/execute', this.handleTerminalRequest.bind(this));

        // Terminal sessions status endpoint
        this.app.get('/api/terminal/sessions', this.handleTerminalSessions.bind(this));

        // Bridge info endpoint (for registration with backend)
        this.app.get('/api/bridge/info', this.handleBridgeInfo.bind(this));
    }

    private async handleHealthCheck(req: express.Request, res: express.Response): Promise<void> {
        try {
            const stats = this.contextManager.getStats();
            const terminalSessions = this.terminalManager.getSessionsStatus();

            res.json({
                success: true,
                status: 'healthy',
                storage: this.storage.initialized,
                contextManager: this.contextManager ? 'ready' : 'not_ready',
                terminalBridge: {
                    ready: true,
                    activeSessions: Object.keys(terminalSessions).length,
                    sessions: terminalSessions
                },
                timestamp: new Date().toISOString(),
                stats: stats,
                server: {
                    port: this.port,
                    uptime: process.uptime()
                }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                status: 'unhealthy',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async handleStreamingContext(req: express.Request, res: express.Response): Promise<void> {
        const { workspaceId } = req.params;
        const maxTokens = parseInt(req.query.maxTokens as string) || 50000;
        const forceRefresh = req.query.forceRefresh === 'true';

        try {
            this.outputChannel.appendLine(`[ContextAPI] Streaming context for workspace: ${workspaceId}`);

            // Set headers for Server-Sent Events
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Cache-Control'
            });

            // Send initial connection confirmation
            this.sendSSEEvent(res, 'connection', {
                workspaceId,
                timestamp: new Date().toISOString(),
                maxTokens
            });

            // Collect fresh context if needed
            let context;
            if (forceRefresh) {
                this.sendSSEEvent(res, 'status', { message: 'Collecting fresh context...' });
                const collectionResult = await this.contextManager.collectContext({
                    collectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector'],
                    options: {
                        includeFileContent: true,
                        maxFileSize: 1048576, // 1MB
                        excludePatterns: ['node_modules', '.git', 'dist', 'build'],
                        includeHiddenFiles: false,
                        respectGitignore: true,
                        maxDepth: 10,
                        parallel: true,
                        useCache: false
                    },
                    timeout: 30000,
                    retryCount: 2
                });
                context = collectionResult.context;
            } else {
                context = await this.storage.getContextForAgent(workspaceId, undefined, maxTokens);
            }

            if (!context) {
                this.sendSSEEvent(res, 'error', { message: 'No context available for workspace' });
                res.end();
                return;
            }

            // Stream context in chunks
            await this.streamContextChunks(res, workspaceId, context);

            // Send completion event
            this.sendSSEEvent(res, 'complete', {
                workspaceId,
                totalTokens: context.totalTokens,
                timestamp: new Date().toISOString()
            });

            res.end();

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Streaming error: ${error}`);
            this.sendSSEEvent(res, 'error', {
                message: error instanceof Error ? error.message : String(error)
            });
            res.end();
        }
    }

    private async streamContextChunks(res: express.Response, workspaceId: string, context: any): Promise<void> {
        const chunks = this.createContextChunks(workspaceId, context);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            this.sendSSEEvent(res, 'chunk', chunk);

            // Small delay between chunks to prevent overwhelming
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    private createContextChunks(workspaceId: string, context: any): StreamingChunk[] {
        const chunks: StreamingChunk[] = [];
        let chunkIndex = 0;

        // Chunk 1: Workspace metadata (always small)
        chunks.push({
            id: `${workspaceId}-workspace`,
            type: 'workspace',
            data: context.workspace,
            chunkIndex: chunkIndex++,
            totalChunks: 0, // Will be updated later
            workspaceId
        });

        // Chunk 2: Active file (can be large due to content)
        if (context.activeFile) {
            const activeFileChunk = { ...context.activeFile };

            // If content is too large, truncate or reference it
            if (activeFileChunk.content && activeFileChunk.content.length > 100000) {
                activeFileChunk.contentTruncated = true;
                activeFileChunk.contentLength = activeFileChunk.content.length;
                activeFileChunk.content = activeFileChunk.content.substring(0, 100000) + '\n\n... [Content truncated]';
            }

            chunks.push({
                id: `${workspaceId}-activeFile`,
                type: 'activeFile',
                data: activeFileChunk,
                chunkIndex: chunkIndex++,
                totalChunks: 0,
                workspaceId
            });
        }

        // Chunk 3: Open files (metadata only, no content)
        chunks.push({
            id: `${workspaceId}-openFiles`,
            type: 'openFiles',
            data: context.openFiles.map((file: any) => ({
                ...file,
                content: undefined // Remove content to reduce size
            })),
            chunkIndex: chunkIndex++,
            totalChunks: 0,
            workspaceId
        });

        // Chunk 4: Project structure
        chunks.push({
            id: `${workspaceId}-projectStructure`,
            type: 'projectStructure',
            data: context.projectStructure,
            chunkIndex: chunkIndex++,
            totalChunks: 0,
            workspaceId
        });

        // Chunk 5: Git context
        chunks.push({
            id: `${workspaceId}-gitContext`,
            type: 'gitContext',
            data: context.gitContext,
            chunkIndex: chunkIndex++,
            totalChunks: 0,
            workspaceId
        });

        // Update total chunks count
        const totalChunks = chunks.length;
        chunks.forEach(chunk => {
            chunk.totalChunks = totalChunks;
        });

        return chunks;
    }

    private sendSSEEvent(res: express.Response, event: string, data: any): void {
        const eventData = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.write(eventData);
    }

    private async handleLegacyContext(req: express.Request, res: express.Response): Promise<void> {
        const { workspaceId } = req.params;
        const maxTokens = parseInt(req.query.maxTokens as string) || 50000;

        try {
            const context = await this.storage.getContextForAgent(workspaceId, undefined, maxTokens);

            if (!context) {
                res.status(404).json({
                    success: false,
                    error: 'Context not found for workspace'
                });
                return;
            }

            // For legacy endpoint, truncate large content
            const compactContext = this.createCompactContext(context);

            res.json({
                success: true,
                context: compactContext,
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private createCompactContext(context: any): any {
        return {
            ...context,
            activeFile: context.activeFile ? {
                ...context.activeFile,
                content: context.activeFile.content ?
                    context.activeFile.content.substring(0, 10000) + (context.activeFile.content.length > 10000 ? '...[truncated]' : '')
                    : undefined
            } : null,
            openFiles: context.openFiles.map((file: any) => ({
                ...file,
                content: undefined // Remove content for compact version
            }))
        };
    }

    private async handleWorkspaceMetadata(req: express.Request, res: express.Response): Promise<void> {
        const { workspaceId } = req.params;

        try {
            const workspace = await this.storage.getWorkspace(workspaceId);

            if (!workspace) {
                res.status(404).json({
                    success: false,
                    error: 'Workspace not found'
                });
                return;
            }

            res.json({
                success: true,
                workspace: workspace,
                workspaceId
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async handleFileContent(req: express.Request, res: express.Response): Promise<void> {
        const { workspaceId } = req.params;
        const filePaths = req.query.paths as string | string[];
        const pathsArray = Array.isArray(filePaths) ? filePaths : [filePaths];

        try {
            const files = await this.storage.getFileStats(workspaceId, 1000);
            const requestedFiles = files.filter(file =>
                pathsArray.some(path => file.path.includes(path))
            );

            res.json({
                success: true,
                files: requestedFiles,
                workspaceId
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async handleWorkspaceStats(req: express.Request, res: express.Response): Promise<void> {
        const { workspaceId } = req.params;

        try {
            const stats = await this.storage.getStorageStats();
            const contextManagerStats = this.contextManager.getStats();

            res.json({
                success: true,
                stats: {
                    storage: stats,
                    contextManager: contextManagerStats,
                    workspaceId
                }
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async handleForceCollection(req: express.Request, res: express.Response): Promise<void> {
        const { workspaceId } = req.params;

        try {
            this.outputChannel.appendLine(`[ContextAPI] Forcing context collection for: ${workspaceId}`);

            const collectionResult = await this.contextManager.collectContext({
                collectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector'],
                options: {
                    includeFileContent: true,
                    maxFileSize: 1048576, // 1MB
                    excludePatterns: ['node_modules', '.git', 'dist', 'build'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth: 10,
                    parallel: true,
                    useCache: false
                },
                timeout: 30000,
                retryCount: 2
            });

            res.json({
                success: true,
                result: {
                    duration: collectionResult.totalDuration,
                    collectors: collectionResult.metadata.collectorCount,
                    successCount: collectionResult.metadata.successCount,
                    errors: collectionResult.errors
                },
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    // Terminal Bridge Handler Methods
    private async handleTerminalRequest(req: express.Request, res: express.Response): Promise<void> {
        const request: TerminalRequest = req.body;

        try {
            this.outputChannel.appendLine(
                `[UnifiedAPI] Processing ${request.operationType} for workspace: ${request.workspacePath}`
            );

            let result: any;

            switch (request.operationType) {
                case 'terminal_command':
                    result = await this.executeTerminalCommand(request);
                    break;
                case 'read_file':
                    result = await this.readFile(request);
                    break;
                case 'write_file':
                    result = await this.writeFile(request);
                    break;
                case 'list_directory':
                    result = await this.listDirectory(request);
                    break;
                case 'delete_file':
                    result = await this.deleteFile(request);
                    break;
                case 'search_files':
                    result = await this.searchFiles(request);
                    break;
                default:
                    throw new Error(`Unsupported operation type: ${request.operationType}`);
            }

            const response: TerminalResponse = {
                success: true,
                data: result,
                timestamp: new Date().toISOString(),
                workspacePath: request.workspacePath,
                operationType: request.operationType
            };

            res.json(response);

        } catch (error) {
            this.outputChannel.appendLine(`[UnifiedAPI] Error processing terminal request: ${error}`);

            const response: TerminalResponse = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
                workspacePath: request.workspacePath || '',
                operationType: request.operationType || 'unknown'
            };

            res.status(500).json(response);
        }
    }

    private async handleTerminalSessions(req: express.Request, res: express.Response): Promise<void> {
        try {
            const sessions = this.terminalManager.getSessionsStatus();
            res.json({
                success: true,
                sessions: sessions,
                totalSessions: Object.keys(sessions).length,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleBridgeInfo(req: express.Request, res: express.Response): Promise<void> {
        res.json({
            bridgeUrl: `http://localhost:${this.port}`,
            port: this.port,
            endpoints: {
                execute: '/api/terminal/execute',
                health: '/api/health',
                sessions: '/api/terminal/sessions',
                context: '/api/workspace/{workspaceId}/context/stream'
            },
            supportedOperations: [
                'terminal_command',
                'read_file',
                'write_file',
                'list_directory',
                'delete_file',
                'search_files'
            ],
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        });
    }

    // Terminal Operation Helper Methods
    private async executeTerminalCommand(request: TerminalRequest): Promise<any> {
        return await this.terminalManager.executeCommand(request.workspacePath, {
            command: request.command,
            workingDirectory: request.workingDirectory,
            environmentVariables: request.environmentVariables,
            isBackground: request.isBackground,
            timeout: request.timeout
        });
    }

    private async readFile(request: TerminalRequest): Promise<any> {
        if (!request.filePath) {
            throw new Error('filePath is required for read_file operation');
        }

        const filePath = path.resolve(request.workspacePath, request.filePath);

        try {
            // Security check - ensure file is within workspace
            if (!filePath.startsWith(request.workspacePath)) {
                throw new Error('Access denied: File is outside workspace');
            }

            const content = await fs.promises.readFile(filePath, 'utf8');
            const lines = content.split('\n');

            if (request.startLine !== undefined && request.endLine !== undefined) {
                const start = Math.max(0, request.startLine - 1);
                const end = Math.min(lines.length, request.endLine);
                const selectedLines = lines.slice(start, end);

                return {
                    content: selectedLines.join('\n'),
                    totalLines: lines.length,
                    selectedLines: selectedLines.length,
                    startLine: request.startLine,
                    endLine: request.endLine,
                    filePath: request.filePath
                };
            }

            return {
                content: content,
                totalLines: lines.length,
                filePath: request.filePath
            };

        } catch (error) {
            throw new Error(`Failed to read file ${request.filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async writeFile(request: TerminalRequest): Promise<any> {
        if (!request.filePath || request.content === undefined) {
            throw new Error('filePath and content are required for write_file operation');
        }

        const filePath = path.resolve(request.workspacePath, request.filePath);

        try {
            // Security check - ensure file is within workspace
            if (!filePath.startsWith(request.workspacePath)) {
                throw new Error('Access denied: File is outside workspace');
            }

            // Ensure directory exists
            const dirPath = path.dirname(filePath);
            await fs.promises.mkdir(dirPath, { recursive: true });

            await fs.promises.writeFile(filePath, request.content, 'utf8');

            return {
                filePath: request.filePath,
                bytesWritten: Buffer.byteLength(request.content, 'utf8'),
                success: true
            };

        } catch (error) {
            throw new Error(`Failed to write file ${request.filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async listDirectory(request: TerminalRequest): Promise<any> {
        const dirPath = request.directoryPath
            ? path.resolve(request.workspacePath, request.directoryPath)
            : request.workspacePath;

        try {
            // Security check - ensure directory is within workspace
            if (!dirPath.startsWith(request.workspacePath)) {
                throw new Error('Access denied: Directory is outside workspace');
            }

            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const items: Array<{
                name: string;
                path: string;
                type: string;
                size: number | null;
                modified: Date;
                created: Date;
            }> = [];

            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                const relativePath = path.relative(request.workspacePath, entryPath);

                try {
                    const stats = await fs.promises.stat(entryPath);
                    items.push({
                        name: entry.name,
                        path: relativePath,
                        type: entry.isDirectory() ? 'directory' : 'file',
                        size: entry.isFile() ? stats.size : null,
                        modified: stats.mtime,
                        created: stats.birthtime
                    });
                } catch (statError) {
                    // Skip entries that can't be accessed
                    this.outputChannel.appendLine(`[UnifiedAPI] Warning: Could not stat ${entryPath}: ${statError}`);
                }
            }

            return {
                directory: request.directoryPath || '.',
                items: items,
                totalItems: items.length
            };

        } catch (error) {
            throw new Error(`Failed to list directory ${request.directoryPath || '.'}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async deleteFile(request: TerminalRequest): Promise<any> {
        if (!request.filePath) {
            throw new Error('filePath is required for delete_file operation');
        }

        const filePath = path.resolve(request.workspacePath, request.filePath);

        try {
            // Security check - ensure file is within workspace
            if (!filePath.startsWith(request.workspacePath)) {
                throw new Error('Access denied: File is outside workspace');
            }

            const stats = await fs.promises.stat(filePath);

            if (stats.isDirectory()) {
                await fs.promises.rmdir(filePath, { recursive: true });
            } else {
                await fs.promises.unlink(filePath);
            }

            return {
                filePath: request.filePath,
                type: stats.isDirectory() ? 'directory' : 'file',
                success: true
            };

        } catch (error) {
            throw new Error(`Failed to delete ${request.filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async searchFiles(request: TerminalRequest): Promise<any> {
        if (!request.searchPattern) {
            throw new Error('searchPattern is required for search_files operation');
        }

        // Use terminal command for file search to leverage system tools
        const searchCommand = process.platform === 'win32'
            ? `findstr /r /s /i "${request.searchPattern}" *.* 2>nul || echo "No matches found"`
            : `grep -r -i "${request.searchPattern}" . 2>/dev/null || echo "No matches found"`;

        const result = await this.terminalManager.executeCommand(request.workspacePath, {
            command: searchCommand,
            workingDirectory: request.directoryPath
                ? path.resolve(request.workspacePath, request.directoryPath)
                : request.workspacePath
        });

        return {
            searchPattern: request.searchPattern,
            searchDirectory: request.directoryPath || '.',
            commandOutput: result.output,
            searchResult: result
        };
    }

    public async start(): Promise<void> {
        if (this.isRunning) {
            this.outputChannel.appendLine('[UnifiedAPI] Server already running');
            return;
        }

        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.port, 'localhost', () => {
                this.isRunning = true;
                this.outputChannel.appendLine(`[UnifiedAPI] Unified API server running on http://localhost:${this.port}`);
                this.outputChannel.appendLine(`[UnifiedAPI] Available endpoints:`);
                this.outputChannel.appendLine(`[UnifiedAPI]   GET /api/health`);
                this.outputChannel.appendLine(`[UnifiedAPI]   Context API:`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/workspace/{id}/context/stream`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/workspace/{id}/context`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/workspace/{id}/collect`);
                this.outputChannel.appendLine(`[UnifiedAPI]   Terminal Bridge API:`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/terminal/execute`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/terminal/sessions`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/bridge/info`);

                // Setup periodic cleanup of inactive terminal sessions
                setInterval(() => {
                    this.terminalManager.cleanupInactiveSessions();
                }, 60 * 60 * 1000); // Every hour

                resolve();
            });

            this.server.on('error', (error: any) => {
                if (error.code === 'EADDRINUSE') {
                    this.outputChannel.appendLine(`[UnifiedAPI] Port ${this.port} in use, trying ${this.port + 1}`);
                    this.port++;
                    if (this.server) {
                        this.server.listen(this.port, 'localhost');
                    }
                } else {
                    this.isRunning = false;
                    this.outputChannel.appendLine(`[UnifiedAPI] Server error: ${error.message}`);
                    reject(error);
                }
            });
        });
    }

    public async stop(): Promise<void> {
        if (this.server && this.isRunning) {
            return new Promise((resolve) => {
                this.server!.close(() => {
                    this.isRunning = false;
                    this.outputChannel.appendLine('[UnifiedAPI] Unified API server stopped');
                    resolve();
                });
            });
        }
    }

    public getPort(): number {
        return this.port;
    }

    public isServerRunning(): boolean {
        return this.isRunning;
    }

    public getBridgeUrl(): string {
        return `http://localhost:${this.port}`;
    }

    // Implement vscode.Disposable
    dispose(): void {
        this.stop().catch(error => {
            this.outputChannel.appendLine(`[UnifiedAPI] Error stopping server: ${error}`);
        });

        // Clean up terminal manager
        this.terminalManager.dispose();
    }
} 