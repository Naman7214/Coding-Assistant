import { EventEmitter } from 'events';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActiveFileCollector } from './collectors/ActiveFileCollector';
import { GitContextCollector } from './collectors/GitContextCollector';
import { OpenFilesCollector } from './collectors/OpenFilesCollector';
import { ProjectStructureCollector } from './collectors/ProjectStructureCollector';
import { FileChangeEvent, FileWatcher } from './FileWatcher';
import { CacheManager } from './storage/CacheManager';
import { VSCodeStorage } from './storage/VSCodeStorage';
import { CollectionRequest, CollectionResult, IContextCollector } from './types/collectors';
import { ContextOptimizationOptions, ContextSession, ProcessedContext, WorkspaceMetadata } from './types/context';

export interface ContextManagerConfig {
    enabled: boolean;
    autoCollectOnChange: boolean;
    autoCollectInterval: number; // milliseconds
    maxCacheSize: number;
    defaultCollectors: string[];
    storageConfig: {
        enableStorage: boolean;
        enableCache: boolean;
    };
    optimizationOptions: ContextOptimizationOptions;
}

export class ContextManager extends EventEmitter {
    private config: ContextManagerConfig;
    private outputChannel: vscode.OutputChannel;
    private storage: VSCodeStorage;
    private cacheManager: CacheManager;
    private fileWatcher: FileWatcher | null = null; // Initialize as null since we'll create it when workspace is ready
    private collectors: Map<string, IContextCollector> = new Map();
    private workspaceId: string = '';
    private workspaceMetadata: WorkspaceMetadata | null = null;
    private isInitialized: boolean = false;
    private disposables: vscode.Disposable[] = [];
    private autoCollectTimer?: NodeJS.Timeout;
    private lastCollectionTime: number = 0;

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        config?: Partial<ContextManagerConfig>
    ) {
        super();

        this.outputChannel = outputChannel;

        // Default configuration
        this.config = {
            enabled: true,
            autoCollectOnChange: true,
            autoCollectInterval: 30000, // 30 seconds
            maxCacheSize: 100 * 1024 * 1024, // 100MB
            defaultCollectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector'],
            storageConfig: {
                enableStorage: true,
                enableCache: true
            },
            optimizationOptions: {
                maxTokens: 50000,
                includeFileContent: true,
                prioritizeRecentFiles: true,
                includeGitContext: true,
                includeLspContext: false,
                includeTerminalContext: false,
                queryRelevanceWeight: 3.0,
                recencyWeight: 2.0,
                frequencyWeight: 1.5
            },
            ...config
        };

        // Initialize storage
        this.storage = new VSCodeStorage(context, outputChannel);
        this.cacheManager = new CacheManager(outputChannel, {
            defaultTtl: 3600, // 1 hour
            checkPeriod: 600, // 10 minutes
            maxKeys: 10000,
            maxMemoryUsage: this.config.maxCacheSize,
            enableStatistics: true,
            compressionThreshold: 1024
        });

        // File watcher will be initialized when workspace is ready
        this.outputChannel.appendLine('[ContextManager] Initialized with configuration');
    }

    /**
     * Initialize the context manager for a workspace
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            this.outputChannel.appendLine('[ContextManager] Starting initialization...');

            // Get workspace information with better error handling
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.outputChannel.appendLine('[ContextManager] No workspace folder found - initializing in limited mode');

                // Initialize storage without workspace context
                if (this.config.storageConfig.enableStorage) {
                    this.outputChannel.appendLine('[ContextManager] Initializing VS Code storage...');
                    await this.storage.initialize();

                    // Use a generic workspace ID when no workspace is available
                    this.workspaceId = `no-workspace-${Date.now()}`;
                    this.outputChannel.appendLine(`[ContextManager] Using fallback workspace ID: ${this.workspaceId}`);
                }

                this.isInitialized = true;
                this.outputChannel.appendLine('[ContextManager] Initialized in limited mode (no workspace)');
                this.emit('initialized', { workspaceId: this.workspaceId, limitedMode: true });
                return;
            }

            this.outputChannel.appendLine(`[ContextManager] Found workspace: ${workspaceFolder.name} at ${workspaceFolder.uri.fsPath}`);

            // Initialize workspace metadata
            this.outputChannel.appendLine('[ContextManager] Initializing workspace metadata...');
            await this.initializeWorkspaceMetadata(workspaceFolder);

            // Initialize storage
            if (this.config.storageConfig.enableStorage) {
                this.outputChannel.appendLine('[ContextManager] Initializing VS Code storage...');
                await this.storage.initialize();
                this.outputChannel.appendLine('[ContextManager] Ensuring workspace in storage...');
                this.workspaceId = await this.ensureWorkspaceInDatabase();
            }

            // Initialize file watcher only if we have a workspace
            if (workspaceFolder) {
                this.outputChannel.appendLine('[ContextManager] Initializing file watcher...');
                this.fileWatcher = new FileWatcher(
                    workspaceFolder.uri.fsPath,
                    this.outputChannel,
                    {
                        enabled: this.config.autoCollectOnChange
                    }
                );

                await this.fileWatcher.startWatching();
            }

            // Initialize default collectors
            this.outputChannel.appendLine('[ContextManager] Initializing collectors...');
            await this.initializeCollectors();

            // Set up event listeners
            this.outputChannel.appendLine('[ContextManager] Setting up event listeners...');
            this.setupEventListeners();

            // Start auto-collection if enabled
            if (this.config.autoCollectOnChange) {
                this.outputChannel.appendLine('[ContextManager] Starting auto-collection...');
                this.startAutoCollection();
            }

            this.isInitialized = true;
            this.outputChannel.appendLine('[ContextManager] Successfully initialized');
            this.emit('initialized', { workspaceId: this.workspaceId });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextManager] Failed to initialize: ${error}`);
            this.outputChannel.appendLine(`[ContextManager] Error stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);

            // Try to continue with limited functionality
            try {
                this.outputChannel.appendLine('[ContextManager] Attempting fallback initialization...');

                // At minimum, try to initialize storage
                if (this.config.storageConfig.enableStorage && !this.storage.initialized) {
                    await this.storage.initialize();
                    this.workspaceId = `fallback-${Date.now()}`;
                }

                this.isInitialized = true;
                this.outputChannel.appendLine('[ContextManager] Fallback initialization successful');
                this.emit('initialized', { workspaceId: this.workspaceId, fallbackMode: true });
                return;
            } catch (fallbackError) {
                this.outputChannel.appendLine(`[ContextManager] Fallback initialization also failed: ${fallbackError}`);
            }

            throw error;
        }
    }

    /**
     * Collect context using specified collectors
     */
    async collectContext(request?: Partial<CollectionRequest>): Promise<CollectionResult> {
        if (!this.isInitialized) {
            throw new Error('ContextManager not initialized');
        }

        const startTime = Date.now();
        const collectionId = this.generateId();

        // Default collection request
        const fullRequest: CollectionRequest = {
            collectors: request?.collectors || this.config.defaultCollectors,
            options: {
                includeFileContent: true,
                maxFileSize: 1024 * 1024, // 1MB
                excludePatterns: ['**/node_modules/**', '**/.git/**'],
                includeHiddenFiles: false,
                respectGitignore: true,
                maxDepth: 10,
                parallel: true,
                useCache: true,
                ...request?.options
            },
            timeout: request?.timeout || 30000, // 30 seconds
            retryCount: request?.retryCount || 2
        };

        this.outputChannel.appendLine(
            `[ContextManager] Starting context collection (ID: ${collectionId}) with ${fullRequest.collectors.length} collectors`
        );

        this.emit('collectionStarted', {
            collectionId,
            collectors: fullRequest.collectors,
            timestamp: Date.now()
        });

        const results: any[] = [];
        const errors: any[] = [];

        try {
            // Log collection strategy
            this.outputChannel.appendLine(
                `[ContextManager] Running collectors in ${fullRequest.options.parallel ? 'parallel' : 'sequential'} mode`
            );

            // Collect from each collector
            const collectorPromises = fullRequest.collectors.map(async (collectorName) => {
                const collector = this.collectors.get(collectorName);
                if (!collector) {
                    const error = `Collector not found: ${collectorName}`;
                    this.outputChannel.appendLine(`[ContextManager] ❌ ${error}`);
                    errors.push({
                        collector: collectorName,
                        error,
                        timestamp: Date.now()
                    });
                    return null;
                }

                try {
                    this.outputChannel.appendLine(`[ContextManager] 🔄 Starting ${collectorName}...`);
                    const collectorStartTime = Date.now();
                    const data = await collector.collectSafely();
                    const collectorDuration = Date.now() - collectorStartTime;

                    this.outputChannel.appendLine(`[ContextManager] ✅ ${collectorName} completed (${collectorDuration}ms)`);

                    return {
                        collector: collectorName,
                        success: true,
                        data,
                        duration: collectorDuration,
                        fromCache: false // This would be determined by the collector
                    };
                } catch (error) {
                    const collectorDuration = Date.now() - startTime;
                    this.outputChannel.appendLine(`[ContextManager] ❌ ${collectorName} failed: ${error instanceof Error ? error.message : String(error)}`);

                    const errorResult = {
                        collector: collectorName,
                        error: error instanceof Error ? error.message : String(error),
                        timestamp: Date.now()
                    };
                    errors.push(errorResult);
                    return {
                        collector: collectorName,
                        success: false,
                        error: errorResult.error,
                        duration: collectorDuration,
                        fromCache: false
                    };
                }
            });

            // Execute collectors (parallel or sequential based on options)
            let collectorResults;
            if (fullRequest.options.parallel) {
                collectorResults = await Promise.allSettled(collectorPromises);
            } else {
                collectorResults = [];
                for (const promise of collectorPromises) {
                    try {
                        const result = await promise;
                        collectorResults.push({ status: 'fulfilled', value: result });
                    } catch (error) {
                        collectorResults.push({ status: 'rejected', reason: error });
                    }
                }
            }

            // Process results
            collectorResults.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value) {
                    results.push(result.value);
                } else if (result.status === 'rejected') {
                    this.outputChannel.appendLine(`[ContextManager] ❌ Collector promise rejected: ${result.reason}`);
                    errors.push({
                        collector: fullRequest.collectors[index],
                        error: result.reason,
                        timestamp: Date.now()
                    });
                }
            });

            this.outputChannel.appendLine(`[ContextManager] 🔧 Building processed context from ${results.length} successful collectors...`);

            // Build processed context
            const processedContext = await this.buildProcessedContext(results);

            // Store context session if VS Code storage is enabled
            if (this.config.storageConfig.enableStorage && processedContext) {
                this.outputChannel.appendLine(`[ContextManager] 💾 Storing context session to storage...`);

                const session: ContextSession = {
                    id: collectionId,
                    workspaceId: this.workspaceId,
                    contextData: processedContext,
                    tokenCount: processedContext.totalTokens,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: '1.0.0'
                };

                await this.storage.storeContextSession(session);
                this.outputChannel.appendLine(`[ContextManager] ✅ Context session stored (${processedContext.totalTokens} tokens)`);
            }

            const totalDuration = Date.now() - startTime;
            this.lastCollectionTime = Date.now();

            const collectionResult: CollectionResult = {
                success: errors.length === 0,
                results,
                errors,
                totalDuration,
                context: processedContext,
                metadata: {
                    collectionId,
                    timestamp: Date.now(),
                    collectorCount: fullRequest.collectors.length,
                    successCount: results.filter(r => r.success).length,
                    cacheHitCount: results.filter(r => r.fromCache).length
                }
            };

            this.outputChannel.appendLine(
                `[ContextManager] 🎉 Context collection completed (${totalDuration}ms, ` +
                `${collectionResult.metadata.successCount}/${collectionResult.metadata.collectorCount} successful)`
            );

            this.emit('collectionCompleted', {
                collectionId,
                result: collectionResult,
                timestamp: Date.now()
            });

            return collectionResult;

        } catch (error) {
            this.outputChannel.appendLine(`[ContextManager] ❌ Context collection failed: ${error}`);

            this.emit('collectionError', {
                collectionId,
                error: error instanceof Error ? error.message : String(error),
                timestamp: Date.now()
            });

            throw error;
        }
    }

    /**
     * Get context for agent (used by agent to retrieve context)
     */
    async getContextForAgent(
        sessionId?: string,
        maxTokens: number = 50000
    ): Promise<ProcessedContext | null> {
        if (!this.isInitialized || !this.config.storageConfig.enableStorage) {
            // Fallback to live collection
            const result = await this.collectContext();
            return result.context;
        }

        return await this.storage.getContextForAgent(
            this.workspaceId,
            sessionId,
            maxTokens
        );
    }

    /**
     * Get workspace ID for agent requests
     */
    getWorkspaceId(): string {
        return this.workspaceId;
    }

    /**
     * Get workspace metadata
     */
    getWorkspaceMetadata(): WorkspaceMetadata | null {
        return this.workspaceMetadata;
    }

    /**
     * Get storage instance
     */
    getStorage(): VSCodeStorage {
        return this.storage;
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<ContextManagerConfig>): void {
        this.config = { ...this.config, ...newConfig };
        this.outputChannel.appendLine('[ContextManager] Configuration updated');

        // Update collector configurations
        this.collectors.forEach(collector => {
            if ('updateConfig' in collector && typeof collector.updateConfig === 'function') {
                collector.updateConfig({
                    enabled: this.config.enabled
                });
            }
        });
    }

    /**
     * Initialize workspace metadata
     */
    private async initializeWorkspaceMetadata(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
        const languages = new Set<string>();
        const packageManagers: string[] = [];

        // Detect package managers
        const packageFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml'];
        for (const file of packageFiles) {
            try {
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, file);
                await vscode.workspace.fs.stat(uri);
                packageManagers.push(path.extname(file) || file);
            } catch {
                // File doesn't exist
            }
        }

        // Detect main language from open files
        vscode.workspace.textDocuments.forEach(doc => {
            if (doc.languageId !== 'plaintext') {
                languages.add(doc.languageId);
            }
        });

        this.workspaceMetadata = {
            path: workspaceFolder.uri.fsPath,
            name: workspaceFolder.name,
            folders: [workspaceFolder.uri.fsPath],
            languages: Array.from(languages),
            mainLanguage: languages.size > 0 ? Array.from(languages)[0] : undefined,
            packageManagers
        };
    }

    /**
     * Ensure workspace exists in database
     */
    private async ensureWorkspaceInDatabase(): Promise<string> {
        if (!this.workspaceMetadata) {
            throw new Error('Workspace metadata not initialized');
        }

        // Check if workspace already exists
        const existing = await this.storage.getWorkspace(this.workspaceMetadata.path);
        if (existing) {
            return existing.id;
        }

        // Create new workspace
        return await this.storage.createOrUpdateWorkspace(this.workspaceMetadata);
    }

    /**
     * Initialize default collectors
     */
    private async initializeCollectors(): Promise<void> {
        // Initialize ActiveFileCollector
        const activeFileCollector = new ActiveFileCollector(
            this.outputChannel,
            this.cacheManager,
            this.workspaceId
        );
        this.collectors.set('ActiveFileCollector', activeFileCollector);

        // Initialize OpenFilesCollector
        const openFilesCollector = new OpenFilesCollector(
            this.outputChannel,
            this.cacheManager,
            this.workspaceId
        );
        this.collectors.set('OpenFilesCollector', openFilesCollector);

        // Initialize ProjectStructureCollector
        const projectStructureCollector = new ProjectStructureCollector(
            this.outputChannel,
            this.cacheManager,
            this.workspaceId
        );
        this.collectors.set('ProjectStructureCollector', projectStructureCollector);

        // Initialize GitContextCollector
        const gitContextCollector = new GitContextCollector(
            this.outputChannel,
            this.cacheManager,
            this.workspaceId
        );
        this.collectors.set('GitContextCollector', gitContextCollector);

        this.outputChannel.appendLine(
            `[ContextManager] Initialized ${this.collectors.size} collectors`
        );
    }

    /**
     * Build processed context from collector results
     */
    private async buildProcessedContext(results: any[]): Promise<ProcessedContext | null> {
        if (results.length === 0) {
            return null;
        }

        // Extract data from successful results
        const activeFileData = results.find(r => r.collector === 'ActiveFileCollector' && r.success)?.data?.data;
        const openFilesData = results.find(r => r.collector === 'OpenFilesCollector' && r.success)?.data?.data;
        const projectStructureData = results.find(r => r.collector === 'ProjectStructureCollector' && r.success)?.data?.data;
        const gitContextData = results.find(r => r.collector === 'GitContextCollector' && r.success)?.data?.data;

        // Build processed context
        const processedContext: ProcessedContext = {
            workspace: this.workspaceMetadata || {
                path: '',
                name: '',
                folders: [],
                languages: [],
                packageManagers: []
            },
            activeFile: activeFileData ? {
                path: activeFileData.file.path,
                relativePath: activeFileData.file.relativePath,
                languageId: activeFileData.file.languageId,
                isDirty: activeFileData.file.isDirty,
                isUntitled: false,
                lineCount: activeFileData.file.lineCount,
                fileSize: activeFileData.file.fileSize,
                lastModified: Date.now(),
                accessFrequency: 1,
                cursorPosition: new vscode.Position(
                    activeFileData.cursor.line,
                    activeFileData.cursor.character
                ),
                selection: activeFileData.cursor.selection,
                visibleRanges: activeFileData.viewport.visibleRanges,
                content: activeFileData.file.content
            } : null,
            openFiles: openFilesData?.files.map((file: any) => ({
                path: file.path,
                relativePath: file.relativePath,
                languageId: file.languageId,
                isDirty: file.isDirty,
                isUntitled: false,
                lineCount: file.lineCount,
                fileSize: file.fileSize,
                lastModified: Date.now(),
                accessFrequency: 1
            })) || [],
            projectStructure: projectStructureData ? {
                directories: projectStructureData.structure.directories.map((dir: any) => ({
                    path: dir.path,
                    relativePath: dir.relativePath,
                    fileCount: dir.fileCount,
                    totalSize: 0, // Would need to calculate
                    lastModified: Date.now(),
                    importance: dir.importance
                })),
                dependencies: projectStructureData.dependencies.map((dep: any) => ({
                    fromFile: dep.fromFile,
                    toFile: dep.toFile,
                    importType: dep.type as 'import' | 'require' | 'include',
                    lineNumber: 0, // Would need to track
                    isExternal: false,
                    packageName: undefined
                })),
                configFiles: projectStructureData.structure.files
                    .filter((file: any) => file.type === 'config')
                    .map((file: any) => file.relativePath),
                mainEntryPoints: projectStructureData.packageInfo.mainFiles || [],
                testFiles: projectStructureData.structure.files
                    .filter((file: any) => file.type === 'test')
                    .map((file: any) => file.relativePath)
            } : {
                directories: [],
                dependencies: [],
                configFiles: [],
                mainEntryPoints: [],
                testFiles: []
            },
            gitContext: gitContextData ? {
                branch: gitContextData.repository.currentBranch,
                hasChanges: gitContextData.status.hasUncommittedChanges,
                changedFiles: gitContextData.status.changedFiles.map((file: any) => file.path),
                recentCommits: gitContextData.history.recentCommits.map((commit: any) => ({
                    hash: commit.hash,
                    message: commit.message,
                    author: commit.author,
                    date: commit.date,
                    filesChanged: commit.filesChanged
                })),
                uncommittedChanges: gitContextData.status.changedFiles.map((file: any) => ({
                    filePath: file.path,
                    changeType: this.parseChangeType(file.status),
                    linesAdded: file.linesAdded,
                    linesDeleted: file.linesDeleted
                })),
                remoteUrl: gitContextData.repository.remoteUrl,
                isRepo: gitContextData.repository.isRepo
            } : {
                branch: '',
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
                currentDirectory: this.workspaceMetadata?.path || '',
                recentCommands: [],
                activeShell: '',
                environmentVariables: {}
            },
            userBehavior: {
                recentFiles: [],
                searchHistory: [],
                navigationPatterns: [],
                editingPatterns: [],
                commandUsage: {}
            },
            relevanceScores: {},
            totalTokens: this.estimateTokenCount(activeFileData, openFilesData, projectStructureData, gitContextData)
        };

        return processedContext;
    }

    /**
     * Parse git change type to our format
     */
    private parseChangeType(gitStatus: string): 'added' | 'modified' | 'deleted' | 'renamed' {
        if (gitStatus.includes('added')) return 'added';
        if (gitStatus.includes('deleted')) return 'deleted';
        if (gitStatus.includes('renamed')) return 'renamed';
        return 'modified';
    }

    /**
     * Estimate token count for context
     */
    private estimateTokenCount(
        activeFileData: any,
        openFilesData: any,
        projectStructureData: any,
        gitContextData: any
    ): number {
        let tokens = 0;

        if (activeFileData) {
            // Roughly 4 characters per token
            tokens += Math.ceil(activeFileData.file.content.length / 4);
        }

        if (openFilesData) {
            // Estimate metadata tokens
            tokens += openFilesData.files.length * 50; // ~50 tokens per file metadata
        }

        if (projectStructureData) {
            // Project structure tokens
            tokens += projectStructureData.structure.files.length * 20; // ~20 tokens per file
            tokens += projectStructureData.dependencies.length * 10; // ~10 tokens per dependency
        }

        if (gitContextData) {
            // Git context tokens
            tokens += gitContextData.history.recentCommits.length * 30; // ~30 tokens per commit
            tokens += Math.ceil((gitContextData.diff.stagedChanges.length + gitContextData.diff.unstagedChanges.length) / 4);
        }

        return tokens;
    }

    /**
     * Setup event listeners
     */
    private setupEventListeners(): void {
        // File watcher events
        this.fileWatcher?.on('fileChanged', (event: FileChangeEvent) => {
            this.handleFileChange(event);
        });

        // VS Code workspace events
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.outputChannel.appendLine('[ContextManager] Workspace folders changed');
                this.reinitialize();
            })
        );
    }

    /**
     * Handle file change events
     */
    private handleFileChange(event: FileChangeEvent): void {
        this.outputChannel.appendLine(
            `[ContextManager] File ${event.type}: ${event.relativePath}`
        );

        // Invalidate relevant caches
        this.cacheManager.clear(`file:${this.workspaceId}:*`);

        // Trigger collection if auto-collect is enabled
        if (this.config.autoCollectOnChange) {
            this.scheduleCollection();
        }

        this.emit('fileChanged', event);
    }

    /**
     * Schedule context collection with debouncing
     */
    private scheduleCollection(): void {
        // Clear existing timer
        if (this.autoCollectTimer) {
            clearTimeout(this.autoCollectTimer);
        }

        // Schedule new collection
        this.autoCollectTimer = setTimeout(() => {
            this.collectContext().catch(error => {
                this.outputChannel.appendLine(`[ContextManager] Auto-collection failed: ${error}`);
            });
        }, 1000); // 1 second debounce
    }

    /**
     * Start auto-collection timer
     */
    private startAutoCollection(): void {
        if (this.autoCollectTimer) {
            clearInterval(this.autoCollectTimer);
        }

        this.autoCollectTimer = setInterval(() => {
            // Only collect if there has been recent activity
            const timeSinceLastCollection = Date.now() - this.lastCollectionTime;
            if (timeSinceLastCollection >= this.config.autoCollectInterval) {
                this.collectContext().catch(error => {
                    this.outputChannel.appendLine(`[ContextManager] Auto-collection failed: ${error}`);
                });
            }
        }, this.config.autoCollectInterval);
    }

    /**
     * Stop auto-collection timer
     */
    private stopAutoCollection(): void {
        if (this.autoCollectTimer) {
            clearTimeout(this.autoCollectTimer);
            this.autoCollectTimer = undefined;
        }
    }

    /**
     * Reinitialize the context manager
     */
    private async reinitialize(): Promise<void> {
        this.isInitialized = false;
        await this.dispose();
        await this.initialize();
    }

    /**
     * Generate unique ID
     */
    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get statistics about the context manager
     */
    getStats(): any {
        return {
            isInitialized: this.isInitialized,
            workspaceId: this.workspaceId,
            collectorsCount: this.collectors.size,
            lastCollectionTime: this.lastCollectionTime,
            cacheStats: this.cacheManager.getStats(),
            fileWatcherStats: this.fileWatcher?.getStats()
        };
    }

    /**
     * Dispose of the context manager
     */
    async dispose(): Promise<void> {
        this.stopAutoCollection();

        // Dispose collectors
        for (const collector of this.collectors.values()) {
            collector.dispose();
        }
        this.collectors.clear();

        // Dispose file watcher
        await this.fileWatcher?.stopWatching();

        // Dispose cache manager
        this.cacheManager.dispose();

        // Close VS Code storage
        await this.storage.close();

        // Dispose VS Code event listeners
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];

        this.isInitialized = false;
        this.removeAllListeners();

        this.outputChannel.appendLine('[ContextManager] Disposed');
    }
} 