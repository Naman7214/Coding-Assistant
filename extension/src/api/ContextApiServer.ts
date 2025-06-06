import cors from 'cors';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { PersistentTerminalManager } from '../bridge/PersistentTerminalManager';
import { ProjectStructureCollector } from '../context/collectors/ProjectStructureCollector';
import { ContextManager } from '../context/ContextManager';
import { VSCodeStorage } from '../context/storage/VSCodeStorage';

interface StreamingChunk {
    id: string;
    type: 'workspace' | 'activeFile' | 'openFiles' | 'projectStructure' | 'gitContext' | 'problems' | 'complete';
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
    silent?: boolean; // Whether to show command in terminal UI
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


        // NEW: On-demand context endpoints (excluding system-info and active-file which are always sent)
        this.app.get('/api/context/problems', this.handleProblemsContext.bind(this));
        this.app.get('/api/context/project-structure', this.handleProjectStructureContext.bind(this));
        this.app.get('/api/context/git', this.handleGitContext.bind(this));
        this.app.get('/api/context/open-files', this.handleOpenFilesContext.bind(this));


        // File content endpoint (on-demand)
        this.app.get('/api/workspace/:workspaceId/files/content', this.handleFileContent.bind(this));


        // Terminal Bridge API routes
        // Main terminal bridge endpoint - single endpoint for all operations
        this.app.post('/api/terminal/execute', this.handleTerminalRequest.bind(this));

        // Terminal sessions status endpoint
        this.app.get('/api/terminal/sessions', this.handleTerminalSessions.bind(this));

        // Bridge info endpoint (for registration with backend)
        this.app.get('/api/bridge/info', this.handleBridgeInfo.bind(this));

        // NEW: Directory listing endpoint (for list_directory tool)
        this.app.post('/api/directory/list', this.handleDirectoryList.bind(this));
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

        // Chunk 6: Problems context
        if (context.problemsContext) {
            chunks.push({
                id: `${workspaceId}-problems`,
                type: 'problems',
                data: context.problemsContext,
                chunkIndex: chunkIndex++,
                totalChunks: 0,
                workspaceId
            });
        }

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

    // NEW: On-demand context endpoint handlers
    private async handleProblemsContext(req: express.Request, res: express.Response): Promise<void> {
        const filePath = req.query.filePath as string;
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting problems context${filePath ? ` for file: ${filePath}` : ' for workspace'}`);

            // Set target file if specified
            if (filePath) {
                this.contextManager.setProblemsTargetFile(filePath);
            }

            const result = await this.contextManager.collectContext({
                collectors: ['ProblemsCollector'],
                options: {
                    includeFileContent: false,
                    maxFileSize: 1048576,
                    excludePatterns: ['node_modules', '.git', 'dist', 'build'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth: 10,
                    parallel: false,
                    useCache: true
                },
                timeout: 10000,
                retryCount: 1
            });

            res.json({
                success: true,
                type: 'problems',
                workspaceId,
                data: result.context?.problemsContext || null,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting problems context: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                type: 'problems'
            });
        }
    }

    private async handleProjectStructureContext(req: express.Request, res: express.Response): Promise<void> {
        const maxDepth = parseInt(req.query.maxDepth as string) || 6;
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting project structure context with maxDepth: ${maxDepth}`);

            const result = await this.contextManager.collectContext({
                collectors: ['ProjectStructureCollector'],
                options: {
                    includeFileContent: false,
                    maxFileSize: 1048576,
                    excludePatterns: ['node_modules', '.git', 'dist', 'build'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth,
                    parallel: false,
                    useCache: true
                },
                timeout: 15000,
                retryCount: 1
            });

            res.json({
                success: true,
                type: 'project-structure',
                workspaceId,
                data: result.context?.projectStructure || null,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting project structure context: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                type: 'project-structure'
            });
        }
    }

    private async handleGitContext(req: express.Request, res: express.Response): Promise<void> {
        const includeChanges = req.query.includeChanges !== 'false';
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting git context with includeChanges: ${includeChanges}`);

            const result = await this.contextManager.collectContext({
                collectors: ['GitContextCollector'],
                options: {
                    includeFileContent: includeChanges,
                    maxFileSize: 1048576,
                    excludePatterns: ['node_modules', '.git', 'dist', 'build'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth: 10,
                    parallel: false,
                    useCache: true
                },
                timeout: 15000,
                retryCount: 1
            });

            res.json({
                success: true,
                type: 'git',
                workspaceId,
                data: result.context?.gitContext || null,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting git context: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                type: 'git'
            });
        }
    }

    private async handleOpenFilesContext(req: express.Request, res: express.Response): Promise<void> {
        const includeContent = req.query.includeContent === 'true';
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting open files context with includeContent: ${includeContent}`);

            const result = await this.contextManager.collectContext({
                collectors: ['OpenFilesCollector'],
                options: {
                    includeFileContent: includeContent,
                    maxFileSize: 1048576,
                    excludePatterns: ['node_modules', '.git', 'dist', 'build'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth: 10,
                    parallel: false,
                    useCache: true
                },
                timeout: 10000,
                retryCount: 1
            });

            res.json({
                success: true,
                type: 'open-files',
                workspaceId,
                data: result.context?.openFiles || null,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting open files context: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                type: 'open-files'
            });
        }
    }

    private async handleDirectoryList(req: express.Request, res: express.Response): Promise<void> {
        const { dir_path, explanation } = req.body;
        const workspaceId = this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Listing directory: ${dir_path || 'workspace root'} - ${explanation}`);

            // Get the ProjectStructureCollector instance
            const projectStructureCollector = this.contextManager.getCollector('ProjectStructureCollector') as ProjectStructureCollector;

            if (!projectStructureCollector) {
                throw new Error('ProjectStructureCollector not available');
            }

            // Use the new listSpecificDirectory method
            const result = await projectStructureCollector.listSpecificDirectory(dir_path);

            res.json({
                success: result.success,
                directory_path: result.directory_path,
                paths: result.paths,
                total_items: result.paths.length,
                workspaceId,
                explanation,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error listing directory: ${error}`);
            res.status(500).json({
                success: false,
                directory_path: dir_path || '.',
                paths: [],
                total_items: 0,
                error: error instanceof Error ? error.message : String(error),
                workspaceId,
                explanation,
                timestamp: new Date().toISOString()
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
                context: '/api/workspace/{workspaceId}/context/stream',
                directoryList: '/api/directory/list'
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
            timeout: request.timeout,
            silent: request.silent
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
                : request.workspacePath,
            silent: true // File search should be invisible
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
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/context/problems`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/context/project-structure`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/context/git`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/context/open-files`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/directory/list`);
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