import * as vscode from 'vscode';

// Core context interfaces
export interface ContextData {
    id: string;
    type: string;
    timestamp: number;
    weight: number;
    data: any;
    metadata?: Record<string, any>;
}

export interface FileInfo {
    path: string;
    relativePath: string;
    content?: string;
    languageId: string;
    lineCount: number;
    fileSize: number;
    lastModified: string;
    relevanceScore?: number;
    cursorPosition?: vscode.Position;
    selection?: vscode.Selection;
    visibleRanges?: readonly vscode.Range[];
    cursorLineContent?: {
        current: string;
        above?: string;
        below?: string;
    };
}

export interface SymbolInfo {
    name: string;
    kind: vscode.SymbolKind;
    range: vscode.Range;
    selectionRange: vscode.Range;
    detail?: string;
    children?: SymbolInfo[];
    containerName?: string;
}

export interface GitContext {
    branch: string;
    hasChanges: boolean;
    changedFiles: string[];
    recentCommits: GitCommit[];
    uncommittedChanges: GitChange[];
    stagedDiff?: string;
    unstagedDiff?: string;
    remoteUrl?: string;
    isRepo: boolean;
}

export interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: Date;
    filesChanged: string[];
}

export interface GitChange {
    filePath: string;
    changeType: 'added' | 'modified' | 'deleted' | 'renamed';
    diffContent?: string;
    linesAdded?: number;
    linesDeleted?: number;
}

export interface WorkspaceMetadata {
    path: string;
    folders: string[];
    totalFiles?: number;
    languages: string[];
    mainLanguage?: string;
    projectType?: string;
    packageManagers: string[];
}

export interface LspContext {
    symbols: SymbolInfo[];
    diagnostics: vscode.Diagnostic[];
    references: vscode.Location[];
    definitions: vscode.Location[];
    hover?: vscode.Hover;
    completions?: vscode.CompletionItem[];
}

export interface ProblemsContext {
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

export interface TerminalContext {
    currentDirectory: string;
    recentCommands: TerminalCommand[];
    activeShell: string;
    environmentVariables: Record<string, string>;
}

export interface TerminalCommand {
    command: string;
    timestamp: number;
    output?: string;
    exitCode?: number;
    duration?: number;
}

export interface UserBehaviorData {
    recentFiles: string[];
    searchHistory: string[];
    navigationPatterns: NavigationPattern[];
    editingPatterns: EditingPattern[];
    commandUsage: Record<string, number>;
}

export interface NavigationPattern {
    fromFile: string;
    toFile: string;
    timestamp: number;
    trigger: 'goto-definition' | 'reference' | 'file-open' | 'search';
}

export interface EditingPattern {
    filePath: string;
    editType: 'insert' | 'delete' | 'replace';
    location: vscode.Range;
    timestamp: number;
    content?: string;
}

// Context session and storage
export interface ContextSession {
    id: string;
    workspaceId: string;
    query?: string;
    queryHash?: string;
    contextData: ProcessedContext;
    tokenCount: number;
    createdAt: number;
    updatedAt: number;
    version: string;
}

export interface ProcessedContext {
    workspace: WorkspaceMetadata;
    activeFile: FileInfo | null;
    openFiles: FileInfo[];
    projectStructure: string;
    gitContext: GitContext;
    lspContext: LspContext;
    problemsContext: ProblemsContext;
    terminalContext: TerminalContext;
    userBehavior: UserBehaviorData;
    relevanceScores: Record<string, number>;
    totalTokens: number;
}

// Context optimization
export interface ContextOptimizationOptions {
    maxTokens: number;
    includeFileContent: boolean;
    prioritizeRecentFiles: boolean;
    includeGitContext: boolean;
    includeLspContext: boolean;
    includeTerminalContext: boolean;
    queryRelevanceWeight: number;
    recencyWeight: number;
    frequencyWeight: number;
}

export interface TokenMetrics {
    total: number;
    byType: Record<string, number>;
    breakdown: {
        activeFile: number;
        openFiles: number;
        projectStructure: number;
        gitContext: number;
        lspContext: number;
        problemsContext: number;
        terminalContext: number;
        userBehavior: number;
    };
}

// Cache and storage
export interface CacheEntry<T> {
    data: T;
    timestamp: number;
    ttl: number;
    version: string;
}

export interface StorageMetrics {
    totalEntries: number;
    totalSize: number;
    cacheHitRate: number;
    averageRetrievalTime: number;
} 