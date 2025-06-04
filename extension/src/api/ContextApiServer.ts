import cors from 'cors';
import express from 'express';
import * as http from 'http';
import * as vscode from 'vscode';
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

export class ContextApiServer implements vscode.Disposable {
    private app: express.Application;
    private server: http.Server | null = null;
    private port: number = 3001;
    private readonly outputChannel: vscode.OutputChannel;
    private isRunning: boolean = false;

    constructor(
        private storage: VSCodeStorage,
        private contextManager: ContextManager,
        outputChannel: vscode.OutputChannel
    ) {
        this.outputChannel = outputChannel;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        this.app.use(cors({
            origin: ['http://localhost:5000', 'http://localhost:5001', 'http://0.0.0.0:5000', 'http://0.0.0.0:5001'],
            credentials: true
        }));

        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Request logging middleware
        this.app.use((req, res, next) => {
            this.outputChannel.appendLine(`[ContextAPI] ${req.method} ${req.path} - ${req.ip}`);
            next();
        });

        // Error handling middleware
        this.app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
            this.outputChannel.appendLine(`[ContextAPI] Error: ${error.message}`);
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
    }

    private async handleHealthCheck(req: express.Request, res: express.Response): Promise<void> {
        try {
            const stats = this.contextManager.getStats();
            res.json({
                success: true,
                status: 'healthy',
                storage: this.storage.initialized,
                contextManager: this.contextManager ? 'ready' : 'not_ready',
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

    public async start(): Promise<void> {
        if (this.isRunning) {
            this.outputChannel.appendLine('[ContextAPI] Server already running');
            return;
        }

        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.port, 'localhost', () => {
                this.isRunning = true;
                this.outputChannel.appendLine(`[ContextAPI] Context API server running on http://localhost:${this.port}`);
                this.outputChannel.appendLine(`[ContextAPI] Available endpoints:`);
                this.outputChannel.appendLine(`[ContextAPI]   GET /api/health`);
                this.outputChannel.appendLine(`[ContextAPI]   GET /api/workspace/{id}/context/stream`);
                this.outputChannel.appendLine(`[ContextAPI]   GET /api/workspace/{id}/context`);
                this.outputChannel.appendLine(`[ContextAPI]   POST /api/workspace/{id}/collect`);
                resolve();
            });

            this.server.on('error', (error: any) => {
                if (error.code === 'EADDRINUSE') {
                    this.outputChannel.appendLine(`[ContextAPI] Port ${this.port} in use, trying ${this.port + 1}`);
                    this.port++;
                    if (this.server) {
                        this.server.listen(this.port, 'localhost');
                    }
                } else {
                    this.isRunning = false;
                    this.outputChannel.appendLine(`[ContextAPI] Server error: ${error.message}`);
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
                    this.outputChannel.appendLine('[ContextAPI] Context API server stopped');
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

    // Implement vscode.Disposable
    dispose(): void {
        this.stop().catch(error => {
            this.outputChannel.appendLine(`[ContextAPI] Error stopping server: ${error}`);
        });
    }
} 