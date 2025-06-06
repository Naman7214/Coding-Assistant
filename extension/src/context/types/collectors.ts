import * as vscode from 'vscode';
import { ContextData, ProcessedContext } from './context';

// Base collector interface
export interface IContextCollector {
    readonly name: string;
    readonly type: string;
    readonly weight: number;

    canCollect(): Promise<boolean>;
    collect(): Promise<ContextData | null>;
    collectSafely(): Promise<ContextData | null>;
    getMetadata(): CollectorMetadata;
    dispose(): void;
}

export interface CollectorMetadata {
    name: string;
    description: string;
    version: string;
    dependencies: string[];
    configurable: boolean;
    cacheable: boolean;
    priority: number;
}

// Collector configuration
export interface CollectorConfig {
    enabled: boolean;
    weight: number;
    options: Record<string, any>;
    cacheTimeout: number;
    maxRetries: number;
}

// Collector results and errors
export interface CollectorResult {
    collector: string;
    success: boolean;
    data?: ContextData;
    error?: string;
    duration: number;
    fromCache: boolean;
}

export interface CollectorError {
    collector: string;
    error: string;
    timestamp: number;
    context?: any;
}

// Specific collector types
export interface ActiveFileCollectorData {
    file: {
        path: string;
        relativePath: string;
        languageId: string;
        lineCount: number;
        fileSize: number;
        lastModified: string;
    };
    cursor: {
        line: number;
        character: number;
        selection: vscode.Range;
        lineContent: {
            current: string;
            above?: string;
            below?: string;
        };
    };
    viewport: {
        visibleRanges: vscode.Range[];
        startLine: number;
        endLine: number;
    };
    context: {
        surroundingLines: string[];
        indentationLevel: number;
        isInFunction: boolean;
        isInClass: boolean;
        nearbySymbols: string[];
    };
}

export interface OpenFilesCollectorData {
    files: Array<{
        path: string;
        relativePath: string;
        languageId: string;
        lineCount: number;
        fileSize: number;
        lastModified: string;
        tabIndex: number;
        isActive: boolean;
    }>;
    totalCount: number;
    languages: string[];
    totalSize: number;
}

export interface ProjectStructureCollectorData {
    root: string;
    treeStructure: string;
    packageInfo: {
        managers: string[];
        mainFiles: string[];
        scripts: Record<string, string>;
    };
}

export interface GitCollectorData {
    repository: {
        isRepo: boolean;
        rootPath: string;
        remoteUrl?: string;
        currentBranch: string;
    };
    status: {
        hasUncommittedChanges: boolean;
        changedFiles: Array<{
            path: string;
            status: string;
            linesAdded: number;
            linesDeleted: number;
        }>;
        untrackedFiles: string[];
    };
    history: {
        recentCommits: Array<{
            hash: string;
            message: string;
            author: string;
            date: Date;
            filesChanged: string[];
        }>;
        branchInfo: {
            ahead: number;
            behind: number;
            upstreamBranch?: string;
        };
    };
    diff: {
        stagedChanges: string;
        unstagedChanges: string;
        conflictFiles: string[];
    };
}

export interface ProblemsCollectorData {
    problems: Array<{
        filePath: string;
        relativePath: string;
        message: string;
        severity: vscode.DiagnosticSeverity;
        source?: string;
        code?: string | number | { value: string | number; target: vscode.Uri };
        range: {
            start: {
                line: number;
                character: number;
            };
            end: {
                line: number;
                character: number;
            };
        };
        position: {
            line: number;
            character: number;
        };
        relatedInformation?: Array<{
            location: {
                uri: string;
                range: {
                    start: { line: number; character: number };
                    end: { line: number; character: number };
                };
            };
            message: string;
        }>;
    }>;
    summary: {
        totalProblems: number;
        errorCount: number;
        warningCount: number;
        infoCount: number;
        hintCount: number;
        filesWithProblems: number;
        problemsByFile: Record<string, number>;
        problemsBySeverity: Record<string, number>;
        problemsBySource: Record<string, number>;
    };
    timestamp: number;
    workspacePath: string;
    requestedFilePath?: string;
}

// Collection orchestration
export interface CollectionRequest {
    collectors: string[];
    options: CollectionOptions;
    timeout: number;
    retryCount: number;
}

export interface CollectionOptions {
    includeFileContent: boolean;
    maxFileSize: number;
    excludePatterns: string[];
    includeHiddenFiles: boolean;
    respectGitignore: boolean;
    maxDepth: number;
    parallel: boolean;
    useCache: boolean;
}

export interface CollectionResult {
    success: boolean;
    results: CollectorResult[];
    errors: CollectorError[];
    totalDuration: number;
    context: ProcessedContext | null;
    metadata: {
        collectionId: string;
        timestamp: number;
        collectorCount: number;
        successCount: number;
        cacheHitCount: number;
    };
}

// Event types for collection lifecycle
export interface CollectionStartEvent {
    collectionId: string;
    collectors: string[];
    timestamp: number;
}

export interface CollectionProgressEvent {
    collectionId: string;
    collector: string;
    progress: number;
    status: string;
    timestamp: number;
}

export interface CollectionCompleteEvent {
    collectionId: string;
    result: CollectionResult;
    timestamp: number;
}

export interface CollectionErrorEvent {
    collectionId: string;
    collector?: string;
    error: string;
    timestamp: number;
}

// Collector registry and management
export interface CollectorRegistry {
    register(collector: IContextCollector): void;
    unregister(name: string): void;
    get(name: string): IContextCollector | undefined;
    getAll(): IContextCollector[];
    getEnabled(): IContextCollector[];
    isEnabled(name: string): boolean;
    setEnabled(name: string, enabled: boolean): void;
    getConfig(name: string): CollectorConfig | undefined;
    setConfig(name: string, config: Partial<CollectorConfig>): void;
}

// Health monitoring
export interface CollectorHealth {
    collector: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    lastSuccess: number;
    consecutiveFailures: number;
    averageResponseTime: number;
    errorRate: number;
    lastError?: string;
}

export interface CollectorPerformanceMetrics {
    collector: string;
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    averageResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    cacheHitRate: number;
    lastUpdated: number;
} 