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

            // Load existing data from globalState
            await this.loadFromGlobalState();

            this.isInitialized = true;
            this.outputChannel.appendLine('[VSCodeStorage] Successfully initialized');
        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Failed to initialize: ${error}`);
            throw error;
        }
    }

    private async loadFromGlobalState(): Promise<void> {
        try {
            // Load workspaces
            const workspacesData = this.context.globalState.get<any[]>('codegen.workspaces', []);
            for (const workspace of workspacesData) {
                this.data.workspaces.set(workspace.metadata.path, {
                    id: workspace.id,
                    metadata: workspace.metadata
                });
            }

            // Load sessions (only keep recent ones to manage memory)
            const sessionsData = this.context.globalState.get<ContextSession[]>('codegen.sessions', []);
            const recentSessions = sessionsData.slice(-100); // Keep only last 100 sessions
            for (const session of recentSessions) {
                this.data.sessions.set(session.id, session);
            }

            // Load file access data
            const filesData = this.context.globalState.get<any>('codegen.files', {});
            for (const [workspaceId, files] of Object.entries(filesData)) {
                this.data.files.set(workspaceId, files as FileInfo[]);
            }

            // Cache is kept in memory only for performance
            this.data.cache.clear();

            this.outputChannel.appendLine(`[VSCodeStorage] Loaded ${this.data.workspaces.size} workspaces, ${this.data.sessions.size} sessions`);
        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Error loading from globalState: ${error}`);
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

    private async saveToGlobalState(): Promise<void> {
        try {
            // Save workspaces
            const workspacesArray = Array.from(this.data.workspaces.values());
            await this.context.globalState.update('codegen.workspaces', workspacesArray);

            // Save sessions (only recent ones)
            const sessionsArray = Array.from(this.data.sessions.values()).slice(-100);
            await this.context.globalState.update('codegen.sessions', sessionsArray);

            // Save file access data
            const filesObject: any = {};
            for (const [workspaceId, files] of this.data.files.entries()) {
                filesObject[workspaceId] = files.slice(-1000); // Keep only last 1000 file accesses per workspace
            }
            await this.context.globalState.update('codegen.files', filesObject);

        } catch (error) {
            this.outputChannel.appendLine(`[VSCodeStorage] Error saving to globalState: ${error}`);
        }
    }

    async createOrUpdateWorkspace(metadata: WorkspaceMetadata): Promise<string> {
        const existingWorkspace = this.data.workspaces.get(metadata.path);
        if (existingWorkspace) {
            existingWorkspace.metadata = metadata;
            await this.saveToGlobalState();
            return existingWorkspace.id;
        }

        const workspaceId = this.generateId();
        this.data.workspaces.set(metadata.path, {
            id: workspaceId,
            metadata
        });

        await this.saveToGlobalState();
        return workspaceId;
    }

    async getWorkspace(workspacePath: string): Promise<{ id: string; metadata: WorkspaceMetadata } | null> {
        return this.data.workspaces.get(workspacePath) || null;
    }

    async storeContextSession(session: ContextSession): Promise<void> {
        this.data.sessions.set(session.id, session);

        // Periodically save to globalState
        if (this.data.sessions.size % 10 === 0) {
            await this.saveToGlobalState();
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
            isDirty: metadata?.isDirty || false,
            isUntitled: metadata?.isUntitled || false,
            lineCount: metadata?.lineCount || 0,
            fileSize: metadata?.fileSize || 0,
            lastModified: metadata?.lastModified || Date.now(),
            accessFrequency: 1,
            content: metadata?.content,
            relevanceScore: metadata?.relevanceScore,
            cursorPosition: metadata?.cursorPosition,
            selection: metadata?.selection,
            visibleRanges: metadata?.visibleRanges
        };

        if (existingIndex >= 0) {
            const existing = files[existingIndex];
            fileInfo.accessFrequency = existing.accessFrequency + 1;
            fileInfo.lastModified = Date.now();
            files[existingIndex] = fileInfo;
        } else {
            files.push(fileInfo);
            // Keep only the most recent 1000 files per workspace
            if (files.length > 1000) {
                files.splice(0, files.length - 1000);
            }
        }

        // Periodically save to globalState
        if (files.length % 50 === 0) {
            await this.saveToGlobalState();
        }
    }

    async getFileStats(workspaceId: string, limit: number = 50): Promise<FileInfo[]> {
        const files = this.data.files.get(workspaceId) || [];
        return files
            .sort((a, b) => b.lastModified - a.lastModified)
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
            await this.saveToGlobalState();
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
                .sort((a, b) => b.lastModified - a.lastModified)
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
                projectStructure: {
                    directories: [],
                    dependencies: [],
                    configFiles: [],
                    mainEntryPoints: [],
                    testFiles: []
                },
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