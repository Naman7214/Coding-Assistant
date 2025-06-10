import cors from 'cors';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ApplyApiRequest, ApplyApiResponse } from '../apply/api/ApplyApiHandler';
import { getApplyApiHandler } from '../apply/api/ApplyApiHandler';
import { PersistentTerminalManager } from '../bridge/PersistentTerminalManager';
import { ContextManager } from '../context/ContextManager';
import { deobfuscatePath } from '../indexing/utils/hash';

// Interface for semantic search result item
interface SemanticSearchResultItem {
    obfuscated_path: string;
    score: number;
    start_line: number;
    end_line: number;
}

// Interface for semantic search request payload
interface SemanticSearchRequest {
    data: SemanticSearchResultItem[];
    message: string;
    error: string | null;
}

// Interface for processed search result response
interface ProcessedSearchResultItem {
    path: string;
    score: number;
    start_line: number;
    end_line: number;
    context_start_line: number;
    context_end_line: number;
    content: string;
    error?: string;
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
    private applyApiHandler: any; // Instance of ApplyApiHandler with proper context

    constructor(
        private contextManager: ContextManager,
        outputChannel: vscode.OutputChannel,
        private extensionContext?: vscode.ExtensionContext
    ) {
        this.outputChannel = outputChannel;
        this.terminalManager = new PersistentTerminalManager(outputChannel);
        // Initialize apply handler with extension context for proper backup storage
        this.applyApiHandler = getApplyApiHandler(this.extensionContext);
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

        // NEW: Semantic search results endpoint (for processing obfuscated paths)
        this.app.post('/api/search/process-results', this.handleSemanticSearchResults.bind(this));

        // APPLY FEATURE ENDPOINTS
        this.app.post('/api/apply', this.handleApplyRequest.bind(this));
        this.app.get('/api/apply/status', this.handleApplyStatus.bind(this));
        this.app.post('/api/apply/cancel', this.handleApplyCancel.bind(this));
        this.app.get('/api/apply/test-connection', this.handleApplyTestConnection.bind(this));
        this.app.get('/api/apply/config', this.handleApplyConfig.bind(this));
        this.app.put('/api/apply/config', this.handleApplyConfigUpdate.bind(this));
        this.app.post('/api/apply/clear-decorations', this.handleApplyClearDecorations.bind(this));
        this.app.get('/api/apply/statistics', this.handleApplyStatistics.bind(this));
    }

    private async handleHealthCheck(req: express.Request, res: express.Response): Promise<void> {
        try {
            const stats = this.contextManager.getStats();
            const terminalSessions = this.terminalManager.getSessionsStatus();

            res.json({
                success: true,
                status: 'healthy',
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


    private async handleFileContent(req: express.Request, res: express.Response): Promise<void> {
        const { paths, workspaceId } = req.query;

        if (!paths) {
            res.status(400).json({
                success: false,
                error: 'File paths are required'
            });
            return;
        }

        const pathsArray = Array.isArray(paths) ? paths : [paths];

        try {
            // Use the file system directly to get the file contents
            const fileContents = await Promise.all(
                pathsArray.map(async (filePath) => {
                    try {
                        const uri = vscode.Uri.file(filePath as string);
                        const content = await vscode.workspace.fs.readFile(uri);
                        const stats = await vscode.workspace.fs.stat(uri);

                        return {
                            path: filePath,
                            content: content.toString(),
                            size: stats.size,
                            lastModified: new Date(stats.mtime).toISOString()
                        };
                    } catch (err) {
                        return {
                            path: filePath,
                            error: err instanceof Error ? err.message : String(err)
                        };
                    }
                })
            );

            res.json({
                success: true,
                files: fileContents,
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

            // Use direct collection without cache
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
                    useCache: false // Don't use cache as requested
                },
                timeout: 10000,
                retryCount: 1
            });

            // Extract problems data from collector results
            let problemsContext = null;

            // Safely extract data
            if (result.results && Array.isArray(result.results)) {
                for (const r of result.results) {
                    if (r.collector === 'ProblemsCollector' && r.data && r.data.data) {
                        problemsContext = r.data.data;
                        break;
                    }
                }
            }

            // Add debug logging
            const hasData = problemsContext !== null;
            this.outputChannel.appendLine(`[ContextAPI] Problems context result: ${hasData ? 'Success' : 'Empty or null'}`);

            res.json({
                success: true,
                type: 'problems',
                workspaceId,
                data: problemsContext,
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
        // Workspace ID is optional, only use if provided
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting project structure context with maxDepth: ${maxDepth}`);

            // Project structure can use cache as specified by user
            const result = await this.contextManager.collectContext({
                collectors: ['ProjectStructureCollector'],
                options: {
                    includeFileContent: false,
                    maxFileSize: 1048576,
                    excludePatterns: ['node_modules', '.git', 'dist', 'build', '.venv', '.env', 'venv', 'env'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth,
                    parallel: false,
                    useCache: true // Can use cache for project structure
                },
                timeout: 15000,
                retryCount: 1
            });

            // Extract project structure data from collector results
            let projectStructure = null;

            // Safely extract data
            if (result.results && Array.isArray(result.results)) {
                for (const r of result.results) {
                    if (r.collector === 'ProjectStructureCollector' && r.data && r.data.data) {
                        projectStructure = r.data.data;
                        break;
                    }
                }
            }

            // Add debug logging
            this.outputChannel.appendLine(`[ContextAPI] Project structure result: ${projectStructure ? 'Success' : 'Empty or null'}`);

            res.json({
                success: true,
                type: 'project-structure',
                workspaceId,
                data: projectStructure,
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
        // Workspace ID is optional, only use if provided
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting git context with includeChanges: ${includeChanges}`);

            // Don't use cache for git context
            const result = await this.contextManager.collectContext({
                collectors: ['GitContextCollector'],
                options: {
                    includeFileContent: includeChanges,
                    maxFileSize: 1048576,
                    excludePatterns: ['node_modules', '.git', 'dist', 'build', '.venv', '.env', 'venv', 'env'],
                    includeHiddenFiles: false,
                    respectGitignore: true,
                    maxDepth: 10,
                    parallel: false,
                    useCache: false // Don't use cache as requested
                },
                timeout: 15000,
                retryCount: 1
            });

            // Extract git context data from collector results
            let gitContext = null;

            // Safely extract data
            if (result.results && Array.isArray(result.results)) {
                for (const r of result.results) {
                    if (r.collector === 'GitContextCollector' && r.data && r.data.data) {
                        gitContext = r.data.data;
                        break;
                    }
                }
            }

            // Add debug logging
            this.outputChannel.appendLine(`[ContextAPI] Git context result: ${gitContext ? 'Success' : 'Empty or null'}`);
            if (!gitContext) {
                this.outputChannel.appendLine(`[ContextAPI] Raw context result: ${JSON.stringify(result.context || {})}`);
            }

            res.json({
                success: true,
                type: 'git',
                workspaceId,
                data: gitContext,
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
        // Workspace ID is optional, only use if provided
        const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

        try {
            this.outputChannel.appendLine(`[ContextAPI] Getting open files context with includeContent: ${includeContent}`);

            // Don't use cache for open files
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
                    useCache: false // Don't use cache as requested
                },
                timeout: 10000,
                retryCount: 1
            });

            // Extract open files data from collector results
            let openFiles = [];

            // Safely extract data
            if (result.results && Array.isArray(result.results)) {
                for (const r of result.results) {
                    if (r.collector === 'OpenFilesCollector' && r.data && r.data.data && r.data.data.files) {
                        openFiles = r.data.data.files;
                        break;
                    }
                }
            }

            // Add debug logging
            const filesCount = Array.isArray(openFiles) ? openFiles.length : 0;
            this.outputChannel.appendLine(`[ContextAPI] Open files result: ${filesCount > 0 ? `Found ${filesCount} files` : 'No open files found'}`);

            res.json({
                success: true,
                type: 'open-files',
                workspaceId,
                data: openFiles,
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
        try {
            const { directoryPath } = req.body;
            const workspaceId = req.body.workspaceId || this.contextManager.getWorkspaceId();

            // Ensure directory path is provided
            if (!directoryPath) {
                throw new Error('Directory path is required');
            }

            this.outputChannel.appendLine(`[ContextAPI] Listing directory: ${directoryPath}`);

            // Better way to get workspace folders
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folders available');
            }

            // Use the first workspace folder as the root
            const workspaceFolder = workspaceFolders[0];
            const workspacePath = workspaceFolder.uri.fsPath;

            this.outputChannel.appendLine(`[ContextAPI] Using workspace folder: ${workspaceFolder.name} at ${workspacePath}`);

            // Resolve directory path - support both absolute and relative paths
            let targetDirPath: string;

            if (path.isAbsolute(directoryPath)) {
                // For absolute paths, use as is
                targetDirPath = directoryPath;
            } else {
                // For relative paths, resolve against workspace path
                targetDirPath = path.resolve(workspacePath, directoryPath);
            }

            // Normalize all paths to handle any platform-specific differences
            const normalizedWorkspacePath = path.normalize(workspacePath);
            const normalizedTargetPath = path.normalize(targetDirPath);

            this.outputChannel.appendLine(`[ContextAPI] Resolved paths:`);
            this.outputChannel.appendLine(`[ContextAPI] - Workspace: ${normalizedWorkspacePath}`);
            this.outputChannel.appendLine(`[ContextAPI] - Target dir: ${normalizedTargetPath}`);

            // Define directories to exclude from listing
            const excludePatterns = [
                'node_modules',
                '.venv',
                'venv',
                'env',
                '.env',
                '.git',
                '.github',
                '.vscode',
                'dist',
                'build',
                '__pycache__',
                '.pytest_cache',
                '.next',
                '.nuxt',
                'target',
                'bin',
                'obj',
                '.idea',
                '.vs',
                'coverage',
                '.nyc_output',
                'temp',
                'tmp'
            ];

            // Helper function to check if an entry should be excluded
            const shouldExclude = (entryName: string): boolean => {
                const lowerName = entryName.toLowerCase();
                return excludePatterns.some(pattern => lowerName === pattern.toLowerCase());
            };

            // Create a helper function to check if path is within workspace
            const isPathWithinWorkspace = (checkPath: string, basePath: string): boolean => {
                // Normalize both paths to handle any path separator differences
                const normalizedCheckPath = path.normalize(checkPath);
                const normalizedBasePath = path.normalize(basePath);

                // On Windows, paths may have different drive letters, so check that
                if (process.platform === 'win32') {
                    const checkDrive = path.parse(normalizedCheckPath).root.toLowerCase();
                    const baseDrive = path.parse(normalizedBasePath).root.toLowerCase();
                    if (checkDrive !== baseDrive) {
                        return false;
                    }
                }

                // Check if the normalized path starts with the normalized workspace path
                // Also consider the case when they are exactly equal
                return normalizedCheckPath === normalizedBasePath ||
                    normalizedCheckPath.startsWith(normalizedBasePath + path.sep);
            };

            // Security check - ensure directory is within workspace
            if (!isPathWithinWorkspace(normalizedTargetPath, normalizedWorkspacePath)) {
                this.outputChannel.appendLine(`[ContextAPI] Security check failed: ${normalizedTargetPath} is not within ${normalizedWorkspacePath}`);
                throw new Error(`Access denied: Directory "${directoryPath}" is outside workspace "${workspaceFolder.name}"`);
            }

            // Use VS Code API for directory listing (more reliable)
            let entries;
            try {
                // Use the VS Code API first
                const targetUri = vscode.Uri.file(targetDirPath);
                this.outputChannel.appendLine(`[ContextAPI] Reading directory with VS Code API: ${targetUri.fsPath}`);
                entries = await vscode.workspace.fs.readDirectory(targetUri);
                this.outputChannel.appendLine(`[ContextAPI] Successfully read directory, found ${entries.length} entries`);
            } catch (err) {
                // Fall back to Node fs if VS Code API fails
                this.outputChannel.appendLine(`[ContextAPI] VS Code API failed, falling back to Node fs: ${err}`);
                entries = await fs.promises.readdir(targetDirPath, { withFileTypes: true });
            }

            const items: Array<{
                path: string;
                type: string;
                created: Date;
            }> = [];

            for (const entry of entries) {
                try {
                    const entryName = entry[0] || entry.name;

                    // Skip excluded directories
                    if (shouldExclude(entryName)) {
                        this.outputChannel.appendLine(`[ContextAPI] Excluding entry: ${entryName}`);
                        continue;
                    }

                    const entryType = entry[1] !== undefined ?
                        (entry[1] === vscode.FileType.Directory ? 'directory' : 'file') :
                        (entry.isDirectory() ? 'directory' : 'file');

                    const entryPath = path.join(targetDirPath, entryName);
                    const relativePath = path.relative(workspacePath, entryPath);

                    let stats;
                    if (vscode.workspace.fs) {
                        const uri = vscode.Uri.file(entryPath);
                        stats = await vscode.workspace.fs.stat(uri);
                    } else {
                        stats = await fs.promises.stat(entryPath);
                    }

                    items.push({
                        path: relativePath,
                        type: entryType,
                        created: new Date(stats.ctime || stats.birthtime || 0)
                    });
                } catch (statError) {
                    // Skip entries that can't be accessed
                    this.outputChannel.appendLine(`[ContextAPI] Warning: Could not stat entry: ${statError}`);
                }
            }

            this.outputChannel.appendLine(`[ContextAPI] Found ${items.length} items in directory ${directoryPath}`);

            res.json({
                success: true,
                workspaceId,
                directoryPath,
                items: items,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Directory list error: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    // NEW: Semantic search results handler
    private async handleSemanticSearchResults(req: express.Request, res: express.Response): Promise<void> {
        try {
            const searchRequest: SemanticSearchRequest = req.body;
            const workspaceId = req.body.workspaceId || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Processing semantic search results with ${searchRequest.data?.length || 0} items`);

            // Validate request
            if (!searchRequest.data || !Array.isArray(searchRequest.data)) {
                res.status(400).json({
                    success: false,
                    error: 'Invalid request: data array is required',
                    timestamp: new Date().toISOString()
                });
                return;
            }

            // Get workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                res.status(500).json({
                    success: false,
                    error: 'No workspace folders available',
                    timestamp: new Date().toISOString()
                });
                return;
            }

            const workspaceFolder = workspaceFolders[0];
            const workspacePath = workspaceFolder.uri.fsPath;

            this.outputChannel.appendLine(`[ContextAPI] Using workspace: ${workspaceFolder.name} at ${workspacePath}`);

            // Process each search result item
            const processedResults: ProcessedSearchResultItem[] = await Promise.all(
                searchRequest.data.map(async (item): Promise<ProcessedSearchResultItem> => {
                    try {
                        // Deobfuscate the path - now returns absolute path directly
                        const absolutePath = deobfuscatePath(item.obfuscated_path);

                        this.outputChannel.appendLine(`[ContextAPI] Deobfuscated absolute path: ${absolutePath}`);

                        // Use the absolute path directly
                        const fullFilePath = absolutePath;

                        // Security check - ensure file is within workspace
                        const normalizedWorkspacePath = path.normalize(workspacePath);
                        const normalizedFilePath = path.normalize(fullFilePath);

                        if (!normalizedFilePath.startsWith(normalizedWorkspacePath + path.sep) &&
                            normalizedFilePath !== normalizedWorkspacePath) {
                            throw new Error(`Access denied: File "${absolutePath}" is outside workspace`);
                        }

                        // Read file content
                        const uri = vscode.Uri.file(fullFilePath);
                        const content = await vscode.workspace.fs.readFile(uri);
                        const fileContent = content.toString();
                        const lines = fileContent.split('\n');

                        // Calculate context lines (original range + 3 lines before and after)
                        const contextStartLine = Math.max(1, item.start_line - 3);
                        const contextEndLine = Math.min(lines.length, item.end_line + 3);

                        // Extract the content with context
                        const startIndex = Math.max(0, contextStartLine - 1);
                        const endIndex = Math.min(lines.length, contextEndLine);
                        const contextLines = lines.slice(startIndex, endIndex);

                        // Calculate the relative path for the response (relative to workspace)
                        const responseRelativePath = path.relative(workspacePath, absolutePath);

                        this.outputChannel.appendLine(
                            `[ContextAPI] Extracted ${contextLines.length} lines from ${responseRelativePath} ` +
                            `(${contextStartLine}:${contextEndLine}, original: ${item.start_line}:${item.end_line})`
                        );

                        return {
                            path: responseRelativePath,
                            score: item.score,
                            start_line: item.start_line,
                            end_line: item.end_line,
                            context_start_line: contextStartLine,
                            context_end_line: contextEndLine,
                            content: contextLines.join('\n')
                        };

                    } catch (error) {
                        this.outputChannel.appendLine(`[ContextAPI] Error processing item: ${error}`);

                        // Try to deobfuscate path for error reporting
                        let pathForError = item.obfuscated_path;
                        try {
                            const absolutePath = deobfuscatePath(item.obfuscated_path);
                            // Convert to relative path for display
                            pathForError = path.relative(workspacePath, absolutePath);
                        } catch {
                            // Use original obfuscated path if deobfuscation fails
                        }

                        return {
                            path: pathForError,
                            score: item.score,
                            start_line: item.start_line,
                            end_line: item.end_line,
                            context_start_line: item.start_line,
                            context_end_line: item.end_line,
                            content: '',
                            error: error instanceof Error ? error.message : String(error)
                        };
                    }
                })
            );

            // Filter successful results and count errors
            const successfulResults = processedResults.filter(result => !result.error);
            const errorCount = processedResults.length - successfulResults.length;

            this.outputChannel.appendLine(
                `[ContextAPI] Processed ${processedResults.length} search results: ` +
                `${successfulResults.length} successful, ${errorCount} errors`
            );

            res.json({
                success: true,
                workspaceId,
                originalMessage: searchRequest.message,
                results: processedResults,
                summary: {
                    totalItems: processedResults.length,
                    successfulItems: successfulResults.length,
                    errorItems: errorCount
                },
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error processing semantic search results: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    // APPLY FEATURE HANDLER METHODS
    private async handleApplyRequest(req: express.Request, res: express.Response): Promise<void> {
        try {
            const requestBody: ApplyApiRequest = req.body;
            const workspaceId = req.body.workspaceId || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Apply request received for file: ${requestBody.filePath}`);

            // Validate request
            if (!requestBody.filePath || !requestBody.codeSnippet) {
                res.status(400).json({
                    success: false,
                    message: 'Missing required fields: filePath and codeSnippet',
                    timestamp: new Date().toISOString()
                });
                return;
            }

            // Execute the apply operation
            const result: ApplyApiResponse = await this.applyApiHandler.handleApplyRequest(requestBody);

            // Log the result
            this.outputChannel.appendLine(`[ContextAPI] Apply completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            if (result.linterErrors && result.linterErrors.length > 0) {
                this.outputChannel.appendLine(`[ContextAPI] Linter errors found: ${result.linterErrors.length}`);
            }

            res.json({
                ...result,
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Apply request failed: ${error}`);
            res.status(500).json({
                success: false,
                message: error instanceof Error ? error.message : 'Unknown error occurred',
                linterErrors: [],
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyStatus(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();
            const status = this.applyApiHandler.getApplyStatus();

            this.outputChannel.appendLine(`[ContextAPI] Apply status requested - In Progress: ${status.inProgress}`);

            res.json({
                success: true,
                workspaceId,
                status,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting apply status: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyCancel(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.body.workspaceId || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Apply cancel requested`);

            this.applyApiHandler.cancelApplyOperation();

            res.json({
                success: true,
                message: 'Apply operation cancelled',
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error cancelling apply operation: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyTestConnection(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Testing FastAPI connection`);

            const isConnected = await this.applyApiHandler.testConnection();

            this.outputChannel.appendLine(`[ContextAPI] FastAPI connection test result: ${isConnected ? 'SUCCESS' : 'FAILED'}`);

            res.json({
                success: true,
                connected: isConnected,
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error testing FastAPI connection: ${error}`);
            res.status(500).json({
                success: false,
                connected: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyConfig(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Apply configuration requested`);

            const config = this.applyApiHandler.getApplyConfig();

            res.json({
                success: true,
                config,
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting apply configuration: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyConfigUpdate(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.body.workspaceId || this.contextManager.getWorkspaceId();
            const newConfig = req.body.config || req.body;

            this.outputChannel.appendLine(`[ContextAPI] Apply configuration update requested`);

            // Remove workspaceId from config if it exists
            const { workspaceId: _, ...configToUpdate } = newConfig;

            this.applyApiHandler.updateApplyConfig(configToUpdate);

            this.outputChannel.appendLine(`[ContextAPI] Apply configuration updated successfully`);

            res.json({
                success: true,
                message: 'Configuration updated successfully',
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error updating apply configuration: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyClearDecorations(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.body.workspaceId || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Clear apply decorations requested`);

            this.applyApiHandler.clearDecorations();

            res.json({
                success: true,
                message: 'Apply decorations cleared successfully',
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error clearing apply decorations: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
        }
    }

    private async handleApplyStatistics(req: express.Request, res: express.Response): Promise<void> {
        try {
            const workspaceId = req.query.workspaceId as string || this.contextManager.getWorkspaceId();

            this.outputChannel.appendLine(`[ContextAPI] Apply statistics requested`);

            const statistics = this.applyApiHandler.getApplyStatistics();

            res.json({
                success: true,
                statistics,
                workspaceId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextAPI] Error getting apply statistics: ${error}`);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : String(error),
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
                directoryList: '/api/directory/list',
                semanticSearchResults: '/api/search/process-results',
                apply: '/api/apply',
                applyStatus: '/api/apply/status',
                applyCancel: '/api/apply/cancel',
                applyTestConnection: '/api/apply/test-connection',
                applyConfig: '/api/apply/config',
                applyClearDecorations: '/api/apply/clear-decorations',
                applyStatistics: '/api/apply/statistics'
            },
            supportedOperations: [
                'terminal_command',
                'read_file',
                'write_file',
                'list_directory',
                'delete_file',
                'search_files',
                'semantic_search_results',
                'apply_code',
                'apply_status',
                'apply_cancel',
                'apply_test_connection',
                'apply_config',
                'apply_clear_decorations',
                'apply_statistics'
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

        // Check if port is in use before starting
        const isPortInUse = await this.checkIfPortInUse(this.port);
        if (isPortInUse) {
            this.outputChannel.appendLine(`[UnifiedAPI] Port ${this.port} is already in use. Attempting to close existing connection.`);

            // Try to force close any existing connection
            try {
                // Create a server that attempts to take over the port
                const tempServer = http.createServer();
                tempServer.once('error', () => {
                    // If we can't take over the port, it's genuinely in use
                    this.outputChannel.appendLine(`[UnifiedAPI] Unable to reclaim port ${this.port}. Please check for other running processes.`);
                });

                await new Promise<void>((resolve) => {
                    tempServer.listen(this.port, 'localhost', () => {
                        // If we successfully bind, we can close it and reuse
                        tempServer.close(() => {
                            this.outputChannel.appendLine(`[UnifiedAPI] Successfully released port ${this.port}`);
                            resolve();
                        });
                    });
                });
            } catch (error) {
                this.outputChannel.appendLine(`[UnifiedAPI] Error trying to reclaim port: ${error instanceof Error ? error.message : String(error)}`);
            }
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
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/search/process-results`);
                this.outputChannel.appendLine(`[UnifiedAPI]   Terminal Bridge API:`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/terminal/execute`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/terminal/sessions`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/bridge/info`);
                this.outputChannel.appendLine(`[UnifiedAPI]   Apply Feature API:`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/apply`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/apply/status`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/apply/cancel`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/apply/test-connection`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/apply/config`);
                this.outputChannel.appendLine(`[UnifiedAPI]     PUT /api/apply/config`);
                this.outputChannel.appendLine(`[UnifiedAPI]     POST /api/apply/clear-decorations`);
                this.outputChannel.appendLine(`[UnifiedAPI]     GET /api/apply/statistics`);

                // Setup periodic cleanup of inactive terminal sessions
                setInterval(() => {
                    this.terminalManager.cleanupInactiveSessions();
                }, 60 * 60 * 1000); // Every hour

                resolve();
            });

            this.server.on('error', (error: any) => {
                if (error.code === 'EADDRINUSE') {
                    this.outputChannel.appendLine(`[UnifiedAPI] Failed to start server on port ${this.port}. Port is in use.`);
                    reject(new Error(`Port ${this.port} is already in use. Please close any other applications using this port.`));
                } else {
                    this.isRunning = false;
                    this.outputChannel.appendLine(`[UnifiedAPI] Server error: ${error.message}`);
                    reject(error);
                }
            });
        });
    }

    /**
     * Check if a port is in use
     */
    private async checkIfPortInUse(port: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const tester = http.createServer()
                .once('error', () => {
                    // Error means port is in use
                    resolve(true);
                })
                .once('listening', () => {
                    // Success means port is free
                    tester.close(() => resolve(false));
                })
                .listen(port, 'localhost');
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

        // Clean up apply handler
        this.applyApiHandler.dispose();
    }
} 