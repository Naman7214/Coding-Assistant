export enum ContextMentionType {
    FILE = 'file',
    DIRECTORY = 'directory',
    GIT = 'git',
    PROJECT = 'project',
    WEB = 'web'
}

export interface ContextSuggestion {
    type: ContextMentionType;
    label: string;  // Changed from 'display' to 'label' to match backend
    value: string;
    description: string;  // Made required to match backend
    icon: string;  // Made required to match backend
}

export interface FileTreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: FileTreeNode[];
    language?: string;
    size?: number;
}

export interface ResolvedContext {
    type: ContextMentionType;
    data: any;
    originalMention: string;
}

export interface ContextChip {
    id: string;
    type: ContextMentionType;
    display: string;
    originalMention: string;
    description?: string;
}

export interface ContextDropdownProps {
    suggestions: ContextSuggestion[];
    visible: boolean;
    position: { top: number; left: number };
    onSelect: (suggestion: ContextSuggestion) => void;
    onClose: () => void;
    selectedIndex: number;
}

export interface FileTreeBrowserProps {
    visible: boolean;
    onSelect: (path: string, type: 'file' | 'directory') => void;
    onClose: () => void;
    title?: string;
}

export interface ContextChipsProps {
    contexts: ContextChip[];
    onRemove: (id: string) => void;
}

// Backend message interfaces
export interface ContextSuggestionsMessage {
    command: 'getContextSuggestions';
    query: string;
}

export interface ContextSuggestionsResponse {
    command: 'contextSuggestions';
    suggestions: ContextSuggestion[];
}

export interface FileTreeMessage {
    command: 'getFileTree';
    path?: string;
}

export interface FileTreeResponse {
    command: 'fileTree';
    tree: FileTreeNode[];
}

export interface ResolveContextMessage {
    command: 'resolveContext';
    mentions: string[];
}

export interface ResolveContextResponse {
    command: 'contextResolved';
    contexts: ResolvedContext[];
} 