// Context Mention Types and Interfaces

export enum ContextMentionType {
    FILE = 'file',
    DIRECTORY = 'directory',
    GIT = 'git',
    PROJECT = 'project',
    WEB = 'web'
}

export interface FileContextData {
    path: string;
    relativePath: string;
    content: string; // First 100 lines
    totalLines: number;
    size: number;
    language?: string;
}

export interface DirectoryContextData {
    path: string;
    relativePath: string;
    files: string[];
    directories: string[];
    totalItems: number;
}

export interface GitContextData {
    branch: string;
    hasChanges: boolean;
    stagedChanges: string;
    unstagedChanges: string;
    recentCommits: any[];
    conflictFiles: string[];
}

export interface ProjectContextData {
    root: string;
    treeStructure: string;
}

export interface WebContextData {
    instruction: string;
}

export interface ContextMention {
    type: ContextMentionType;
    value: string; // file path, directory path, or context type
    label: string; // display name for UI
    resolved: boolean;
    data?: FileContextData | DirectoryContextData | GitContextData | ProjectContextData | WebContextData;
    error?: string;
}

export interface ContextSuggestion {
    type: ContextMentionType;
    label: string;
    value: string;
    description: string;
    icon: string; // VS Code icon name
}

export interface FileTreeItem {
    name: string;
    path: string;
    relativePath: string;
    type: 'file' | 'directory';
    size?: number;
    language?: string;
    children?: FileTreeItem[];
    isExpanded?: boolean;
}

export interface ContextMentionResult {
    mentions: ContextMention[];
    resolvedCount: number;
    errors: string[];
}

// Message interfaces for webview communication
export interface GetContextSuggestionsMessage {
    command: 'getContextSuggestions';
    query: string;
    cursorPosition: number;
}

export interface GetFileTreeMessage {
    command: 'getFileTree';
    path?: string; // Optional path to specific directory
    maxDepth?: number;
}

export interface ResolveContextMessage {
    command: 'resolveContext';
    mentions: ContextMention[];
}

export interface ContextSuggestionsResponse {
    command: 'contextSuggestions';
    suggestions: ContextSuggestion[];
    files: FileTreeItem[];
}

export interface FileTreeResponse {
    command: 'fileTree';
    tree: FileTreeItem[];
    path: string;
}

export interface ResolvedContextResponse {
    command: 'resolvedContext';
    result: ContextMentionResult;
} 