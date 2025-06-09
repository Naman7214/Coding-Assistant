import { EventEmitter } from 'events';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActiveFileCollector } from './collectors/ActiveFileCollector';
import { GitContextCollector } from './collectors/GitContextCollector';
import { OpenFilesCollector } from './collectors/OpenFilesCollector';
import { ProblemsCollector } from './collectors/ProblemsCollector';
import { ProjectStructureCollector } from './collectors/ProjectStructureCollector';
import { RecentEditsCollector } from './collectors/RecentEditsCollector';
import { FileChangeEvent, FileWatcher } from './FileWatcher';
import { CacheManager } from './storage/CacheManager';
import { VSCodeStorage } from './storage/VSCodeStorage';
import { CollectionRequest, CollectionResult, CollectorResult, IContextCollector } from './types/collectors';
import { ContextOptimizationOptions, ProcessedContext, WorkspaceMetadata } from './types/context';

// Constants for different context types
export enum ContextType {
    SYSTEM_INFO = 'systemInfo',
    ACTIVE_FILE = 'activeFile',
    OPEN_FILES = 'openFiles',
    PROJECT_STRUCTURE = 'projectStructure',
    GIT_CONTEXT = 'gitContext',
    PROBLEMS = 'problems',
    REPO_MAP = 'repoMap',
    RECENT_EDITS = 'recentEdits'
}

// Cache TTL constants (in seconds)
export const CACHE_TTL = {
    SYSTEM_INFO: 24 * 60 * 60, // 24 hours
    PROJECT_STRUCTURE: 3600, // 1 hour
    REPO_MAP: 3600, // 1 hour
    NO_CACHE: 0 // No caching
};

// Define which context types should be cached
export const CACHEABLE_CONTEXTS = [
    ContextType.SYSTEM_INFO,
    ContextType.PROJECT_STRUCTURE,
    ContextType.REPO_MAP
];

// Define which contexts must be sent with every query
export const MUST_SEND_CONTEXTS = [
    ContextType.SYSTEM_INFO,
    ContextType.ACTIVE_FILE,
    ContextType.OPEN_FILES,
    ContextType.RECENT_EDITS
];

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
    private context: vscode.ExtensionContext;
    private fileWatcher: FileWatcher | null = null; // Initialize as null since we'll create it when workspace is ready
    private collectors: Map<string, IContextCollector> = new Map();
    private workspaceId: string = '';
    private workspaceMetadata: WorkspaceMetadata | null = null;
    private isInitialized: boolean = false;
    private disposables: vscode.Disposable[] = [];
    private autoCollectTimer?: NodeJS.Timeout;
    private lastCollectionTime: number = 0;
    private lastWorkspacePath: string = '';

    constructor(
        context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        config?: Partial<ContextManagerConfig>
    ) {
        super();

        this.context = context;
        this.outputChannel = outputChannel;

        // Default configuration
        this.config = {
            enabled: true,
            autoCollectOnChange: true,
            autoCollectInterval: 30000, // 30 seconds
            maxCacheSize: 100 * 1024 * 1024, // 100MB
            defaultCollectors: ['ActiveFileCollector', 'OpenFilesCollector', 'ProjectStructureCollector', 'GitContextCollector', 'ProblemsCollector', 'RecentEditsCollector'],
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
            this.lastWorkspacePath = workspaceFolder.uri.fsPath;

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

            // Pre-cache contexts that need to be available immediately
            this.outputChannel.appendLine('[ContextManager] Pre-caching important contexts...');
            await this.preCacheRequiredContexts();

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
     * Pre-cache required contexts that should be available immediately
     */
    private async preCacheRequiredContexts(): Promise<void> {
        try {
            // Pre-cache system information
            await this.collectSystemInformation();

            // Pre-cache project structure
            if (this.collectors.has('ProjectStructureCollector')) {
                const collector = this.collectors.get('ProjectStructureCollector');
                if (collector) {
                    const data = await collector.collectSafely();
                    if (data) {
                        await this.cacheManager.storeContextData(
                            this.workspaceId,
                            ContextType.PROJECT_STRUCTURE,
                            data,
                            CACHE_TTL.PROJECT_STRUCTURE
                        );
                        this.outputChannel.appendLine('[ContextManager] Project structure pre-cached successfully');
                    }
                }
            }
        } catch (error) {
            this.outputChannel.appendLine(`[ContextManager] Error during pre-caching: ${error}`);
        }
    }

    /**
     * Collect and cache system information
     */
    private async collectSystemInformation(): Promise<any> {
        try {
            this.outputChannel.appendLine('[ContextManager] Collecting system information...');

            // Get fresh system info
            const systemInfo = await this.getSystemInfo();

            if (!systemInfo) {
                this.outputChannel.appendLine('[ContextManager] Failed to collect system information');
                return null;
            }

            // Format system info with proper metadata for storage
            const systemInfoData = {
                id: this.generateId(),
                type: ContextType.SYSTEM_INFO,
                timestamp: Date.now(),
                weight: 1,
                data: systemInfo,
                metadata: {
                    collector: 'SystemInfoCollector',
                    cacheable: true,
                    cacheTimeout: CACHE_TTL.SYSTEM_INFO
                }
            };

            // Store in cache with 24-hour TTL
            const cacheKey = this.generateCacheKey('SystemInfoCollector', ContextType.SYSTEM_INFO);
            await this.cacheManager.storeContextData(
                this.workspaceId,
                ContextType.SYSTEM_INFO,
                systemInfoData,
                CACHE_TTL.SYSTEM_INFO // 24 hours
            );

            this.outputChannel.appendLine(`[ContextManager] System information cached with 24-hour TTL (${CACHE_TTL.SYSTEM_INFO} seconds)`);
            return systemInfoData;

        } catch (error) {
            this.outputChannel.appendLine(`[ContextManager] Error collecting system information: ${error}`);
            return null;
        }
    }

    /**
     * Get system information
     */
    private async getSystemInfo(): Promise<any> {
        try {
            const vscodeVersion = vscode.version;
            const extensionVersion = vscode.extensions.getExtension('vscode.enhanced-assistant')?.packageJSON.version || 'unknown';
            const platform = process.platform;
            const architecture = process.arch;
            const osVersion = process.platform === 'darwin' ? 'macOS' :
                process.platform === 'win32' ? 'Windows' :
                    process.platform === 'linux' ? 'Linux' : 'Unknown';

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const workspacePath = workspaceFolder?.uri.fsPath || '';
            const workspaceName = workspaceFolder?.name || '';

            return {
                vscode: {
                    version: vscodeVersion,
                    extensionVersion
                },
                system: {
                    platform,
                    architecture,
                    osVersion
                },
                workspace: {
                    path: workspacePath,
                    name: workspaceName
                },
                timestamp: Date.now()
            };
        } catch (error) {
            this.outputChannel.appendLine(`[ContextManager] Error getting system info: ${error}`);
            return {
                error: 'Failed to get system information',
                timestamp: Date.now()
            };
        }
    }

    /**
     * Check if a context type should be cached
     */
    isCacheableContext(contextType: string): boolean {
        return CACHEABLE_CONTEXTS.includes(contextType as ContextType);
    }

    /**
     * Check if a context must be sent with every query
     */
    isMustSendContext(contextType: string): boolean {
        return MUST_SEND_CONTEXTS.includes(contextType as ContextType);
    }

    /**
     * Get TTL for a specific context type
     */
    getContextTTL(contextType: string): number {
        switch (contextType) {
            case ContextType.SYSTEM_INFO:
                return CACHE_TTL.SYSTEM_INFO;
            case ContextType.PROJECT_STRUCTURE:
                return CACHE_TTL.PROJECT_STRUCTURE;
            case ContextType.REPO_MAP:
                return CACHE_TTL.REPO_MAP;
            default:
                return CACHE_TTL.NO_CACHE;
        }
    }

    /**
     * Check if workspace has changed since last check
     */
    private hasWorkspaceChanged(): boolean {
        const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const hasChanged = this.lastWorkspacePath !== currentWorkspace && currentWorkspace !== '';

        if (hasChanged) {
            this.outputChannel.appendLine(`[ContextManager] Workspace changed from ${this.lastWorkspacePath} to ${currentWorkspace}`);
        }

        return hasChanged;
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
        this.outputChannel.appendLine(
            `[ContextManager] Requested collectors: ${JSON.stringify(fullRequest.collectors)}`
        );
        this.outputChannel.appendLine(
            `[ContextManager] Available collectors: ${JSON.stringify(Array.from(this.collectors.keys()))}`
        );

        this.emit('collectionStarted', {
            collectionId,
            collectors: fullRequest.collectors,
            timestamp: Date.now()
        });

        const results: any[] = [];
        const errors: any[] = [];

        // Check if workspace has changed, and if so, recache system info
        if (this.hasWorkspaceChanged()) {
            this.outputChannel.appendLine('[ContextManager] Workspace changed, recaching system information');
            this.lastWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            await this.collectSystemInformation();
        }

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
                    errors.push({ collector: collectorName, error });
                    this.outputChannel.appendLine(`[ContextManager] ${error}`);
                    return null;
                }

                try {
                    // For non-cacheable contexts or when cache is disabled, always collect fresh data
                    if (!this.isCacheableContext(collector.type) || !fullRequest.options.useCache) {
                        const data = await collector.collectSafely();
                        if (data) {
                            results.push(data);
                            return data;
                        }
                        return null;
                    }

                    // For cacheable contexts, check cache first
                    const cacheKey = this.generateCacheKey(collector.name, collector.type);
                    const cached = await this.cacheManager.getContextData(
                        this.workspaceId,
                        collector.type,
                        cacheKey
                    );

                    if (cached) {
                        this.outputChannel.appendLine(`[ContextManager] Using cached data for ${collectorName}`);
                        results.push(cached);
                        return cached;
                    }

                    // If not in cache, collect and cache
                    const data = await collector.collectSafely();
                    if (data) {
                        results.push(data);

                        // Cache the data if it's a cacheable context type
                        if (this.isCacheableContext(collector.type)) {
                            const ttl = this.getContextTTL(collector.type);
                            await this.cacheManager.storeContextData(
                                this.workspaceId,
                                collector.type,
                                data,
                                ttl
                            );
                        }

                        return data;
                    }

                    return null;
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    errors.push({ collector: collectorName, error: errorMsg });
                    this.outputChannel.appendLine(`[ContextManager] Error collecting from ${collectorName}: ${errorMsg}`);
                    return null;
                }
            });

            // Process collections based on requested execution mode
            if (fullRequest.options.parallel) {
                await Promise.all(collectorPromises);
            } else {
                for (const promise of collectorPromises) {
                    await promise;
                }
            }

            // Process results into unified context structure
            const processedContext = await this.buildProcessedContext(results);

            const duration = Date.now() - startTime;
            this.lastCollectionTime = Date.now();

            // Convert results to CollectorResult[] format as expected by the interface
            const collectorResults: CollectorResult[] = results.map(r => ({
                collector: r.metadata?.collector || 'unknown',
                success: true,
                data: r,
                duration: 0, // We don't have individual durations here
                fromCache: false // We don't know if it's from cache
            }));

            const result: CollectionResult = {
                success: errors.length === 0,
                results: collectorResults,
                errors: errors.length > 0 ? errors.map(e => ({
                    collector: e.collector,
                    error: e.error,
                    timestamp: Date.now()
                })) : [],
                totalDuration: duration,
                context: processedContext,
                metadata: {
                    collectionId,
                    timestamp: Date.now(),
                    collectorCount: fullRequest.collectors.length,
                    successCount: collectorResults.length,
                    cacheHitCount: 0 // We don't know this yet
                }
            };

            this.emit('collectionCompleted', {
                collectionId,
                timestamp: Date.now(),
                duration,
                result
            });

            this.outputChannel.appendLine(
                `[ContextManager] Collection completed in ${duration}ms with ${results.length} results and ${errors.length} errors`
            );

            return result;

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[ContextManager] Collection failed: ${errorMsg}`);

            const result: CollectionResult = {
                success: false,
                results: [],
                errors: [{
                    collector: 'ContextManager',
                    error: errorMsg,
                    timestamp: Date.now()
                }],
                totalDuration: Date.now() - startTime,
                context: null,
                metadata: {
                    collectionId,
                    timestamp: Date.now(),
                    collectorCount: fullRequest.collectors.length,
                    successCount: 0,
                    cacheHitCount: 0
                }
            };

            this.emit('collectionFailed', {
                collectionId,
                timestamp: Date.now(),
                error: errorMsg
            });

            return result;
        }
    }

    /**
     * Collect all contexts that must be sent with every query
     */
    async collectMustSendContexts(): Promise<Map<string, any>> {
        const contexts = new Map<string, any>();

        // Check and update system info if needed (expired or workspace changed)
        if (this.hasWorkspaceChanged()) {
            await this.collectSystemInformation();
        }

        // Get system info from cache
        const systemInfo = await this.cacheManager.getContextData(
            this.workspaceId,
            ContextType.SYSTEM_INFO,
            'SystemInfoCollector'
        );

        if (systemInfo) {
            contexts.set(ContextType.SYSTEM_INFO, systemInfo);
        } else {
            // If not in cache, collect and cache it
            const newSystemInfo = await this.collectSystemInformation();
            if (newSystemInfo) {
                contexts.set(ContextType.SYSTEM_INFO, newSystemInfo);
            }
        }

        // Always collect fresh active file context
        if (this.collectors.has('ActiveFileCollector')) {
            const collector = this.collectors.get('ActiveFileCollector');
            if (collector) {
                const data = await collector.collectSafely();
                if (data) {
                    contexts.set(ContextType.ACTIVE_FILE, data);
                }
            }
        }

        // Always collect fresh open files context
        if (this.collectors.has('OpenFilesCollector')) {
            const collector = this.collectors.get('OpenFilesCollector');
            if (collector) {
                const data = await collector.collectSafely();
                if (data) {
                    contexts.set(ContextType.OPEN_FILES, data);
                }
            }
        }

        // Always collect fresh recent edits context
        if (this.collectors.has('RecentEditsCollector')) {
            const collector = this.collectors.get('RecentEditsCollector');
            if (collector) {
                const data = await collector.collectSafely();
                if (data) {
                    contexts.set(ContextType.RECENT_EDITS, data);
                }
            }
        }

        return contexts;
    }

    /**
     * Collect context for a specific type (on-demand context)
     */
    async collectSpecificContext(contextType: string): Promise<any> {
        // For system info, get from cache or collect if not available
        if (contextType === ContextType.SYSTEM_INFO) {
            const cached = await this.cacheManager.getContextData(
                this.workspaceId,
                ContextType.SYSTEM_INFO,
                'SystemInfoCollector'
            );

            if (cached) {
                return cached;
            }

            return await this.collectSystemInformation();
        }

        // For git context, always collect fresh
        if (contextType === ContextType.GIT_CONTEXT && this.collectors.has('GitContextCollector')) {
            const collector = this.collectors.get('GitContextCollector');
            if (collector) {
                return await collector.collectSafely();
            }
        }

        // For project structure, check cache first
        if (contextType === ContextType.PROJECT_STRUCTURE && this.collectors.has('ProjectStructureCollector')) {
            const collector = this.collectors.get('ProjectStructureCollector');
            if (collector) {
                const cacheKey = this.generateCacheKey(collector.name, collector.type);
                const cached = await this.cacheManager.getContextData(
                    this.workspaceId,
                    ContextType.PROJECT_STRUCTURE,
                    cacheKey
                );

                if (cached) {
                    return cached;
                }

                const data = await collector.collectSafely();
                if (data) {
                    await this.cacheManager.storeContextData(
                        this.workspaceId,
                        ContextType.PROJECT_STRUCTURE,
                        data,
                        CACHE_TTL.PROJECT_STRUCTURE
                    );
                    return data;
                }
            }
        }

        // For active file or open files, always collect fresh
        if ((contextType === ContextType.ACTIVE_FILE && this.collectors.has('ActiveFileCollector')) ||
            (contextType === ContextType.OPEN_FILES && this.collectors.has('OpenFilesCollector'))) {
            const collectorName = contextType === ContextType.ACTIVE_FILE ?
                'ActiveFileCollector' : 'OpenFilesCollector';

            const collector = this.collectors.get(collectorName);
            if (collector) {
                return await collector.collectSafely();
            }
        }

        return null;
    }

    /**
     * Generate cache key for a collector
     */
    private generateCacheKey(collectorName: string, contextType: string): string {
        return `${collectorName}_${contextType}`;
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
        const problemsData = results.find(r => r.collector === 'ProblemsCollector' && r.success)?.data?.data;
        const recentEditsData = results.find(r => r.collector === 'RecentEditsCollector' && r.success)?.data?.data;

        // Build processed context
        const processedContext: ProcessedContext = {
            workspace: {
                path: this.workspaceMetadata?.path || '',
                folders: this.workspaceMetadata?.folders || [],
                languages: this.workspaceMetadata?.languages || [],
                packageManagers: this.workspaceMetadata?.packageManagers || []
            },
            activeFile: activeFileData ? {
                path: activeFileData.file?.path || '',
                relativePath: activeFileData.file?.relativePath || '',
                languageId: activeFileData.file?.languageId || '',
                lineCount: activeFileData.file?.lineCount || 0,
                fileSize: activeFileData.file?.fileSize || 0,
                lastModified: activeFileData.file?.lastModified || new Date().toISOString(),
                cursorPosition: activeFileData.cursor ? new vscode.Position(
                    Math.max(0, (activeFileData.cursor.line || 0)),
                    Math.max(0, (activeFileData.cursor.character || 1) - 1)
                ) : new vscode.Position(0, 0),
                selection: activeFileData.cursor?.selection || new vscode.Selection(
                    new vscode.Position(0, 0),
                    new vscode.Position(0, 0)
                ),
                visibleRanges: activeFileData.viewport?.visibleRanges || [],
                cursorLineContent: activeFileData.cursor?.lineContent || undefined
            } : null,
            openFiles: openFilesData?.files ? openFilesData.files.map((file: any) => ({
                path: file.path || '',
                relativePath: file.relativePath || '',
                languageId: file.languageId || '',
                lineCount: file.lineCount || 0,
                fileSize: file.fileSize || 0,
                lastModified: file.lastModified || new Date().toISOString()
            })) : [],
            projectStructure: projectStructureData?.treeStructure || '',
            gitContext: gitContextData ? {
                branch: gitContextData.repository?.currentBranch || '',
                hasChanges: gitContextData.status?.hasUncommittedChanges || false,
                changedFiles: gitContextData.status?.changedFiles?.map((file: any) => file.path) || [],
                recentCommits: gitContextData.history?.recentCommits?.map((commit: any) => ({
                    hash: commit.hash || '',
                    message: commit.message || '',
                    author: commit.author || '',
                    date: commit.date || new Date(),
                    filesChanged: commit.filesChanged || []
                })) || [],
                uncommittedChanges: gitContextData.status?.changedFiles?.map((file: any) => ({
                    filePath: file.path || '',
                    changeType: this.parseChangeType(file.status) || 'modified',
                    linesAdded: file.linesAdded || 0,
                    linesDeleted: file.linesDeleted || 0
                })) || [],
                stagedDiff: gitContextData.diff?.stagedChanges || '',
                unstagedDiff: gitContextData.diff?.unstagedChanges || '',
                remoteUrl: gitContextData.repository?.remoteUrl,
                isRepo: gitContextData.repository?.isRepo || false
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
            problemsContext: problemsData ? {
                problems: problemsData.problems || [],
                summary: problemsData.summary || {
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
                timestamp: problemsData.timestamp || Date.now(),
                workspacePath: problemsData.workspacePath || this.workspaceMetadata?.path || '',
                requestedFilePath: problemsData.requestedFilePath
            } : {
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
                workspacePath: this.workspaceMetadata?.path || ''
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
            recentEdits: recentEditsData || undefined,
            relevanceScores: {},
            totalTokens: this.estimateTokenCount(activeFileData, openFilesData, projectStructureData, gitContextData, problemsData, recentEditsData)
        };

        // Add system info
        if (results.some(r => r.collector === 'SystemInfoCollector')) {
            const systemInfo = results.find(r => r.collector === 'SystemInfoCollector' && r.success)?.data?.data;
            if (systemInfo) {
                processedContext.relevanceScores['systemInfo'] = systemInfo;
            }
        }

        return processedContext;
    }

    /**
     * Parse git change type to our format
     */
    private parseChangeType(gitStatus: string | null | undefined): 'added' | 'modified' | 'deleted' | 'renamed' {
        if (!gitStatus || typeof gitStatus !== 'string') {
            return 'modified';
        }

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
        gitContextData: any,
        problemsData?: any,
        recentEditsData?: any
    ): number {
        let tokens = 0;

        if (activeFileData?.file) {
            // Roughly 4 characters per token for the active file content
            // Since we don't include content anymore, estimate based on file size
            tokens += Math.ceil((activeFileData.file.fileSize || 0) / 4);

            // Add tokens for surrounding lines context
            if (activeFileData.context?.surroundingLines) {
                const contextText = activeFileData.context.surroundingLines.join('\n');
                tokens += Math.ceil(contextText.length / 4);
            }

            // Add tokens for cursor line content
            if (activeFileData.cursor?.lineContent) {
                const cursorContent = activeFileData.cursor.lineContent;
                const lineContentText = [
                    cursorContent.above || '',
                    cursorContent.current || '',
                    cursorContent.below || ''
                ].join('\n');
                tokens += Math.ceil(lineContentText.length / 4);
            }
        }

        if (openFilesData?.files && Array.isArray(openFilesData.files)) {
            // Estimate metadata tokens
            tokens += openFilesData.files.length * 50; // ~50 tokens per file metadata
        }

        if (projectStructureData?.treeStructure) {
            // Project structure tokens
            tokens += Math.ceil(projectStructureData.treeStructure.length / 4);
        }

        if (gitContextData) {
            // Git context tokens
            if (gitContextData.history?.recentCommits && Array.isArray(gitContextData.history.recentCommits)) {
                tokens += gitContextData.history.recentCommits.length * 30; // ~30 tokens per commit
            }

            const stagedChanges = gitContextData.diff?.stagedChanges || '';
            const unstagedChanges = gitContextData.diff?.unstagedChanges || '';
            tokens += Math.ceil((stagedChanges.length + unstagedChanges.length) / 4);
        }

        if (problemsData?.problems && Array.isArray(problemsData.problems)) {
            // Estimate problems tokens - ~50 tokens per problem (message + metadata)
            tokens += problemsData.problems.length * 50;
        }

        if (recentEditsData) {
            // Recent edits tokens - metadata + diff content
            tokens += 100; // Base metadata tokens

            // Add tokens for modified files diffs
            if (recentEditsData.modifiedFiles && Array.isArray(recentEditsData.modifiedFiles)) {
                for (const file of recentEditsData.modifiedFiles) {
                    if (file.diffs && Array.isArray(file.diffs)) {
                        for (const diff of file.diffs) {
                            tokens += Math.ceil((diff.content || '').length / 4);
                        }
                    }
                }
            }

            // Add tokens for added/deleted files (just metadata)
            const totalFilesCount = (recentEditsData.addedFiles?.length || 0) +
                (recentEditsData.deletedFiles?.length || 0);
            tokens += totalFilesCount * 30; // ~30 tokens per file metadata
        }

        return tokens;
    }

    /**
     * Set up event listeners for file changes and other events
     */
    private setupEventListeners(): void {
        if (!this.fileWatcher) {
            return;
        }

        // Listen for file changes
        this.fileWatcher.on('fileChange', async (event: FileChangeEvent) => {
            this.emit('fileChanged', event);
            this.outputChannel.appendLine(`[ContextManager] File changed: ${event.relativePath} (${event.type})`);
        });

        // Listen for project structure changes (file/directory creation, deletion, renaming)
        this.fileWatcher.on('projectStructureChange', async (event: FileChangeEvent) => {
            this.outputChannel.appendLine(`[ContextManager] Project structure changed: ${event.relativePath} (${event.type})`);

            // Invalidate project structure cache and recollect
            await this.recacheProjectStructure();
        });

        // Add other event listeners as needed
    }

    /**
     * Recache the project structure when files/directories are created or deleted
     */
    private async recacheProjectStructure(): Promise<void> {
        if (this.collectors.has('ProjectStructureCollector')) {
            this.outputChannel.appendLine('[ContextManager] Recaching project structure...');

            const collector = this.collectors.get('ProjectStructureCollector');
            if (collector) {
                // Clear existing cache for project structure
                const cacheKey = this.generateCacheKey(collector.name, ContextType.PROJECT_STRUCTURE);
                this.cacheManager.delete(cacheKey);

                // Collect fresh project structure
                const data = await collector.collectSafely();
                if (data) {
                    await this.cacheManager.storeContextData(
                        this.workspaceId,
                        ContextType.PROJECT_STRUCTURE,
                        data,
                        CACHE_TTL.PROJECT_STRUCTURE
                    );
                    this.outputChannel.appendLine('[ContextManager] Project structure recached successfully');
                }
            }
        }
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
            folders: [workspaceFolder.uri.fsPath],
            languages: Array.from(languages),
            mainLanguage: languages.size > 0 ? Array.from(languages)[0] : undefined,
            projectType: packageManagers.length > 0 ? packageManagers[0] : undefined,
            packageManagers: packageManagers
        };
    }

    /**
     * Ensure workspace exists in database
     */
    private async ensureWorkspaceInDatabase(): Promise<string> {
        // Generate a workspace ID
        return this.generateId();
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

        // Initialize ProblemsCollector
        const problemsCollectorInstance = new ProblemsCollector(
            this.outputChannel,
            this.cacheManager,
            this.workspaceId
        );
        this.collectors.set('ProblemsCollector', problemsCollectorInstance);

        // Initialize RecentEditsCollector
        const recentEditsCollector = new RecentEditsCollector(
            this.outputChannel,
            this.cacheManager,
            this.workspaceId,
            this.context
        );
        this.collectors.set('RecentEditsCollector', recentEditsCollector);

        this.outputChannel.appendLine(
            `[ContextManager] Initialized ${this.collectors.size} collectors: ${Array.from(this.collectors.keys()).join(', ')}`
        );
    }

    /**
     * Get context for agent with proper caching behavior
     */
    async getContextForAgent(
        sessionId?: string,
        maxTokens: number = 50000
    ): Promise<ProcessedContext | null> {
        if (!this.isInitialized) {
            throw new Error('ContextManager not initialized');
        }

        // Collect all must-send contexts
        const mustSendContexts = await this.collectMustSendContexts();

        // Start building the processed context
        const processedContext: ProcessedContext = {
            workspace: this.workspaceMetadata || {
                path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                folders: [vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''],
                languages: [],
                packageManagers: []
            },
            activeFile: null,
            openFiles: [],
            projectStructure: '',
            gitContext: {
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
                workspacePath: this.workspaceMetadata?.path || ''
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
            totalTokens: 0
        };

        // Add system info
        if (mustSendContexts.has(ContextType.SYSTEM_INFO)) {
            const systemInfo = mustSendContexts.get(ContextType.SYSTEM_INFO);
            processedContext.relevanceScores['systemInfo'] = systemInfo.data;
        }

        // Add active file
        if (mustSendContexts.has(ContextType.ACTIVE_FILE)) {
            const activeFileData = mustSendContexts.get(ContextType.ACTIVE_FILE);
            processedContext.activeFile = activeFileData.data;
        }

        // Add open files
        if (mustSendContexts.has(ContextType.OPEN_FILES)) {
            const openFilesData = mustSendContexts.get(ContextType.OPEN_FILES);
            processedContext.openFiles = openFilesData.data.files || [];
        }

        // Add recent edits
        if (mustSendContexts.has(ContextType.RECENT_EDITS)) {
            const recentEditsData = mustSendContexts.get(ContextType.RECENT_EDITS);
            processedContext.recentEdits = recentEditsData.data;
        }

        // Get project structure from cache
        const projectStructureData = await this.cacheManager.getContextData(
            this.workspaceId,
            ContextType.PROJECT_STRUCTURE,
            this.generateCacheKey('ProjectStructureCollector', ContextType.PROJECT_STRUCTURE)
        );

        if (projectStructureData) {
            processedContext.projectStructure = projectStructureData.data;
        }

        // Estimate token count
        processedContext.totalTokens = this.estimateTokenCount(
            processedContext.activeFile,
            processedContext.openFiles,
            processedContext.projectStructure,
            processedContext.gitContext,
            processedContext.problemsContext,
            processedContext.recentEdits
        );

        return processedContext;
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
     * Set target file path for ProblemsCollector
     */
    setProblemsTargetFile(filePath?: string): void {
        const problemsCollector = this.collectors.get('ProblemsCollector');
        if (problemsCollector && 'setTargetFilePath' in problemsCollector) {
            (problemsCollector as any).setTargetFilePath(filePath);
            this.outputChannel.appendLine(`[ContextManager] Set problems target file: ${filePath || 'all workspace'}`);
        }
    }

    /**
     * Get stats for files in the workspace
     */
    async getFileStats(workspaceId: string, limit: number = 1000): Promise<any[]> {
        // If we have the project structure collector, use that to get file stats
        if (this.collectors.has('ProjectStructureCollector')) {
            const collector = this.collectors.get('ProjectStructureCollector');
            if (collector) {
                const data = await collector.collectSafely();
                if (data && data.data && data.data.files) {
                    return data.data.files.slice(0, limit);
                }
            }
        }

        // Fallback: return empty array
        return [];
    }
} 