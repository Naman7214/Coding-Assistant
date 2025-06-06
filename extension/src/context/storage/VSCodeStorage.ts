import * as path from 'path';
import * as vscode from 'vscode';
import {
    ContextSession,
    FileInfo,
    ProcessedContext,
    WorkspaceMetadata
} from '../types/context';

interface StorageData {
    workspaces: Map<string, { id: string; metadata: WorkspaceMetadata }>;
    sessions: Map<string, ContextSession>;
    files: Map<string, FileInfo[]>;
    cache: Map<string, any>;
    metrics: Array<any>;
}

export class VSCodeStorage {
    private context: vscode.ExtensionContext;
    private readonly outputChannel: vscode.OutputChannel;
    private isInitialized = false;
    private data: StorageData;

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.data = {
            workspaces: new Map(),
            sessions: new Map(),
            files: new Map(),
            cache: new Map(),
            metrics: []
        };
    }

    /**
     * Check if the storage is initialized
     */
    public get initialized(): boolean {
        return this.isInitialized;
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            this.outputChannel.appendLine('[VSCodeStorage] Initializing VS Code storage...');

            // Load existing data from workspace storage
            await this.loadFromWorkspaceState();

            this.isInitialized = true;
            this.outputChannel.appendLine('[VSCodeStorage] Successfully initialized');
        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Failed to initialize: ${error}`);
            throw error;
        }
    }

    private async loadFromWorkspaceState(): Promise<void> {
        try {
            // Check if workspace is available
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                this.outputChannel.appendLine('[VSCodeStorage] No workspace open, using minimal storage');
                return;
            }

            // Load workspace metadata (keep this in global for workspace discovery)
            const workspacesData = this.context.globalState.get<any[]>('codegen.workspaces', []);
            for (const workspace of workspacesData) {
                this.data.workspaces.set(workspace.metadata.path, {
                    id: workspace.id,
                    metadata: workspace.metadata
                });
            }

            // Load workspace-specific data from workspaceState
            const sessionsData = this.context.workspaceState.get<ContextSession[]>('codegen.sessions', []);
            const recentSessions = sessionsData.slice(-100); // Keep only last 100 sessions
            for (const session of recentSessions) {
                this.data.sessions.set(session.id, session);
            }

            // Load file access data for current workspace
            const filesData = this.context.workspaceState.get<FileInfo[]>('codegen.files', []);
            const currentWorkspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            this.data.files.set(currentWorkspacePath, filesData);

            // Cache is kept in memory only for performance
            this.data.cache.clear();

            this.outputChannel.appendLine(`[VSCodeStorage] Loaded ${this.data.workspaces.size} workspaces, ${this.data.sessions.size} sessions`);
        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Error loading from workspaceState: ${error}`);
            // Initialize with empty data if loading fails
            this.data = {
                workspaces: new Map(),
                sessions: new Map(),
                files: new Map(),
                cache: new Map(),
                metrics: []
            };
        }
    }

    private async saveToWorkspaceState(): Promise<void> {
        try {
            // Save workspace list to global state for discovery
            const workspacesArray = Array.from(this.data.workspaces.values());
            await this.context.globalState.update('codegen.workspaces', workspacesArray);

            // Only save to workspace state if workspace is open
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                return;
            }

            // Save sessions to workspace-specific storage
            const sessionsArray = Array.from(this.data.sessions.values()).slice(-100);
            await this.context.workspaceState.update('codegen.sessions', sessionsArray);

            // Save file access data for current workspace only
            const currentWorkspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const currentWorkspaceFiles = this.data.files.get(currentWorkspacePath) || [];
            const limitedFiles = currentWorkspaceFiles.slice(-1000); // Keep only last 1000 file accesses
            await this.context.workspaceState.update('codegen.files', limitedFiles);

        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Error saving to workspaceState: ${error}`);
        }
    }

    async createOrUpdateWorkspace(metadata: WorkspaceMetadata): Promise<string> {
        const existingWorkspace = this.data.workspaces.get(metadata.path);
        if (existingWorkspace) {
            existingWorkspace.metadata = metadata;
            await this.saveToWorkspaceState();
            return existingWorkspace.id;
        }

        const workspaceId = this.generateId();
        this.data.workspaces.set(metadata.path, {
            id: workspaceId,
            metadata
        });

        await this.saveToWorkspaceState();
        return workspaceId;
    }

    async getWorkspace(workspacePath: string): Promise<{ id: string; metadata: WorkspaceMetadata } | null> {
        return this.data.workspaces.get(workspacePath) || null;
    }

    async storeContextSession(session: ContextSession): Promise<void> {
        this.data.sessions.set(session.id, session);

        // Periodically save to workspace state
        if (this.data.sessions.size % 10 === 0) {
            await this.saveToWorkspaceState();
        }
    }

    async getContextSession(sessionId: string): Promise<ContextSession | null> {
        return this.data.sessions.get(sessionId) || null;
    }

    async trackFileAccess(workspaceId: string, filePath: string, metadata?: Partial<FileInfo>): Promise<void> {
        if (!this.data.files.has(workspaceId)) {
            this.data.files.set(workspaceId, []);
        }

        const files = this.data.files.get(workspaceId)!;
        const existingIndex = files.findIndex(f => f.path === filePath);

        const fileInfo: FileInfo = {
            path: filePath,
            relativePath: metadata?.relativePath || path.relative(workspaceId, filePath),
            languageId: metadata?.languageId || 'unknown',
            lineCount: metadata?.lineCount || 0,
            fileSize: metadata?.fileSize || 0,
            lastModified: metadata?.lastModified || new Date().toISOString(),
            relevanceScore: metadata?.relevanceScore,
            cursorPosition: metadata?.cursorPosition,
            selection: metadata?.selection,
            visibleRanges: metadata?.visibleRanges,
            cursorLineContent: metadata?.cursorLineContent
        };

        if (existingIndex >= 0) {
            const existing = files[existingIndex];
            fileInfo.lastModified = new Date().toISOString();
            files[existingIndex] = fileInfo;
        } else {
            files.push(fileInfo);
            // Keep only the most recent 1000 files per workspace
            if (files.length > 1000) {
                files.splice(0, files.length - 1000);
            }
        }

        // Periodically save to workspace state
        if (files.length % 50 === 0) {
            await this.saveToWorkspaceState();
        }
    }

    async getFileStats(workspaceId: string, limit: number = 50): Promise<FileInfo[]> {
        const files = this.data.files.get(workspaceId) || [];
        return files
            .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
            .slice(0, limit);
    }

    async storeInCache(
        workspaceId: string,
        key: string,
        dataType: string,
        content: string,
        tokenCount: number = 0,
        ttlSeconds: number = 3600
    ): Promise<void> {
        const cacheKey = `${workspaceId}:${key}`;
        const expiry = new Date(Date.now() + ttlSeconds * 1000);

        this.data.cache.set(cacheKey, {
            dataType,
            content,
            tokenCount,
            createdAt: new Date(),
            expiry
        });

        // Clean expired entries periodically
        if (this.data.cache.size % 100 === 0) {
            this.cleanExpiredCache();
        }
    }

    async getFromCache(workspaceId: string, key: string): Promise<any | null> {
        const cacheKey = `${workspaceId}:${key}`;
        const cached = this.data.cache.get(cacheKey);

        if (!cached) {
            return null;
        }

        if (new Date() > cached.expiry) {
            this.data.cache.delete(cacheKey);
            return null;
        }

        return cached;
    }

    async clearCache(workspaceId?: string): Promise<void> {
        if (workspaceId) {
            const keys = Array.from(this.data.cache.keys()).filter(key => key.startsWith(`${workspaceId}:`));
            keys.forEach(key => this.data.cache.delete(key));
        } else {
            this.data.cache.clear();
        }
    }

    private cleanExpiredCache(): void {
        const now = new Date();
        for (const [key, value] of this.data.cache.entries()) {
            if (now > value.expiry) {
                this.data.cache.delete(key);
            }
        }
    }

    async recordPerformanceMetric(
        workspaceId: string,
        operationType: string,
        collectorName: string | null,
        durationMs: number,
        success: boolean,
        errorMessage?: string,
        metadata?: any
    ): Promise<void> {
        const metric = {
            workspaceId,
            operationType,
            collectorName,
            durationMs,
            success,
            errorMessage,
            metadata,
            timestamp: new Date()
        };

        this.data.metrics.push(metric);

        // Keep only the last 1000 metrics
        if (this.data.metrics.length > 1000) {
            this.data.metrics.splice(0, this.data.metrics.length - 1000);
        }
    }

    async getStorageStats(): Promise<any> {
        return {
            workspacesCount: this.data.workspaces.size,
            sessionsCount: this.data.sessions.size,
            cacheSize: this.data.cache.size,
            metricsCount: this.data.metrics.length,
            totalFileEntries: Array.from(this.data.files.values()).reduce((sum, files) => sum + files.length, 0)
        };
    }

    async close(): Promise<void> {
        if (this.isInitialized) {
            await this.saveToWorkspaceState();
            this.isInitialized = false;
        }
    }

    async getContextForAgent(
        workspaceId: string,
        sessionId?: string,
        maxTokens: number = 50000
    ): Promise<ProcessedContext | null> {
        try {
            const files = this.data.files.get(workspaceId) || [];
            const session = sessionId ? this.data.sessions.get(sessionId) : null;

            // Build context from most recently accessed files
            const recentFiles = files
                .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
                .slice(0, 20); // Limit to 20 most recent files

            // Return the session's context data if available, otherwise create a minimal one
            if (session) {
                return session.contextData;
            }

            // Create a minimal context structure
            const workspace = this.data.workspaces.get(workspaceId);
            if (!workspace) {
                return null;
            }

            return {
                workspace: workspace.metadata,
                activeFile: recentFiles[0] || null,
                openFiles: recentFiles,
                projectStructure: 'No project structure available',
                gitContext: {
                    branch: 'main',
                    hasChanges: false,
                    changedFiles: [],
                    recentCommits: [],
                    uncommittedChanges: [],
                    isRepo: false
                },
                lspContext: {
                    symbols: [],
                    diagnostics: [],
                    references: [],
                    definitions: []
                },
                problemsContext: {
                    problems: [],
                    summary: {
                        totalProblems: 0,
                        errorCount: 0,
                        warningCount: 0,
                        infoCount: 0,
                        hintCount: 0,
                        filesWithProblems: 0,
                        problemsByFile: {},
                        problemsBySeverity: {},
                        problemsBySource: {}
                    },
                    timestamp: Date.now(),
                    workspacePath: workspace.metadata.path
                },
                terminalContext: {
                    currentDirectory: workspace.metadata.path,
                    recentCommands: [],
                    activeShell: 'bash',
                    environmentVariables: {}
                },
                userBehavior: {
                    recentFiles: recentFiles.map(f => f.path),
                    searchHistory: [],
                    navigationPatterns: [],
                    editingPatterns: [],
                    commandUsage: {}
                },
                relevanceScores: {},
                totalTokens: Math.min(maxTokens, recentFiles.length * 100) // Rough estimate
            };
        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Error getting context: ${error}`);
            return null;
        }
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
} 