import * as vscode from 'vscode';

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ApplyRequest {
    filePath: string;
    codeSnippet: string;
    explanation?: string;
}

export interface ApplyResponse {
    success: boolean;
    message: string;
    linterErrors?: LinterError[];
    appliedChanges?: AppliedChange[];
}

// ============================================================================
// Stream Event Types (matching sample_stream.py format)
// ============================================================================

export interface StreamEvent {
    type: StreamEventType;
    content: string;
    metadata: StreamEventMetadata;
    timestamp: number;
}

export type StreamEventType =
    | 'start'
    | 'model_preparation'
    | 'model_request'
    | 'model_streaming'
    | 'model_output'
    | 'code_generation_start'
    | 'code_chunk'
    | 'code_generation_complete'
    | 'completion'
    | 'error';

export interface StreamEventMetadata {
    [key: string]: any;
    chunk_number?: number;
    total_code_length?: number;
    is_inside_code_block?: boolean;
    model?: string;
    stage?: string;
    explanation?: string;
    code_snippet_length?: number;
    target_content_length?: number;
    final_content_length?: number;
    total_chunks_processed?: number;
    edited_content?: string;
}

// ============================================================================
// Code Processing Types
// ============================================================================

export interface CodeChunk {
    content: string;
    lineNumber: number;
    chunkIndex: number;
    isInsideCodeBlock: boolean;
    totalLength: number;
}

export interface AppliedChange {
    type: 'addition' | 'deletion' | 'modification';
    lineNumber: number;
    content: string;
    originalContent?: string;
}

// ============================================================================
// Diff and Decoration Types
// ============================================================================

export interface DiffResult {
    additions: DiffLine[];
    deletions: DiffLine[];
    modifications: DiffLine[];
    unchanged: DiffLine[];
}

export interface DiffLine {
    lineNumber: number;
    content: string;
    type: 'added' | 'removed' | 'modified' | 'unchanged';
}

export interface DecorationState {
    addedLines: vscode.DecorationOptions[];
    removedLines: vscode.DecorationOptions[];
    modifiedLines: vscode.DecorationOptions[];
    streamingLines: vscode.DecorationOptions[];
}

// ============================================================================
// Linter and Error Types
// ============================================================================

export interface LinterError {
    file: string;
    line: number;
    column: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
    source: string;
    code?: string;
}

export interface LinterResult {
    errors: LinterError[];
    warnings: LinterError[];
    totalCount: number;
}

// ============================================================================
// Service Configuration Types
// ============================================================================

export interface ApplyConfig {
    fastApiUrl: string;
    streamingTimeout: number;
    maxRetries: number;
    debounceDelay: number;
    showProgressIndicator: boolean;
    autoCollectLinterErrors: boolean;
    preserveDecorations: boolean;
    decorationTimeout: number;
}

export interface HttpClientConfig {
    baseUrl: string;
    timeout: number;
    retryCount: number;
    retryDelay: number;
}

// ============================================================================
// Progress and Status Types
// ============================================================================

export interface ProgressState {
    stage: 'preparing' | 'streaming' | 'applying' | 'completing' | 'error';
    progress: number; // 0-100
    message: string;
    chunksProcessed: number;
    totalChunks: number;
    bytesProcessed: number;
    totalBytes: number;
}

export interface StatusBarState {
    text: string;
    tooltip: string;
    command?: string;
    color?: vscode.ThemeColor;
    priority: number;
}

// ============================================================================
// Manager and Service Interfaces
// ============================================================================

export interface IApplyManager {
    applyCodeToFile(request: ApplyRequest): Promise<ApplyResponse>;
    cancelCurrentOperation(): void;
    isOperationInProgress(): boolean;
    dispose(): void;
}

export interface IStreamProcessor {
    processStreamEvent(event: StreamEvent, chunkIndex: number): Promise<{ content: string; updateProgress: boolean; }>;
    onProgress(callback: (state: ProgressState) => void): void;
    onError(callback: (error: Error) => void): void;
    cancel(): void;
    reset(): void;
    initialize(): void;
    complete(): void;
}

export interface IFileUpdateService {
    readFileContent(filePath: string): Promise<string>;
    writeFileContent(filePath: string, content: string): Promise<void>;
    createBackup(filePath: string): Promise<string>;
    restoreFromBackup(filePath: string, backupPath: string): Promise<void>;
    validateFilePath(filePath: string): boolean;
}

export interface ILinterService {
    collectErrors(uri: vscode.Uri): Promise<LinterError[]>;
    watchForErrors(uri: vscode.Uri, callback: (errors: LinterError[]) => void): vscode.Disposable;
    formatErrors(errors: vscode.Diagnostic[]): LinterError[];
}

export interface IDiffRenderer {
    calculateDiff(original: string, modified: string): DiffResult;
    renderDiff(editor: vscode.TextEditor, diff: DiffResult): void;
    clearDiff(editor: vscode.TextEditor): void;
    animateChanges(editor: vscode.TextEditor, changes: AppliedChange[]): Promise<void>;
    addFileControls(
        editor: vscode.TextEditor,
        filePath: string,
        onDecision: (accepted: boolean) => Promise<void>
    ): void;
    clearFileControls(editor: vscode.TextEditor, filePath: string): void;
    showVSCodeDiff(
        originalContent: string,
        modifiedContent: string,
        filePath: string
    ): void;
}

// ============================================================================
// Event Types
// ============================================================================

export interface ApplyStartEvent {
    type: 'apply_start';
    filePath: string;
    timestamp: number;
}

export interface ApplyProgressEvent {
    type: 'apply_progress';
    filePath: string;
    progress: ProgressState;
    timestamp: number;
}

export interface ApplyCompleteEvent {
    type: 'apply_complete';
    filePath: string;
    success: boolean;
    linterErrors: LinterError[];
    timestamp: number;
}

export interface ApplyErrorEvent {
    type: 'apply_error';
    filePath: string;
    error: Error;
    timestamp: number;
}

export type ApplyEvent = ApplyStartEvent | ApplyProgressEvent | ApplyCompleteEvent | ApplyErrorEvent;

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_APPLY_CONFIG: ApplyConfig = {
    fastApiUrl: 'http://127.0.0.1:8000',
    streamingTimeout: 30000,
    maxRetries: 3,
    debounceDelay: 100,
    showProgressIndicator: true,
    autoCollectLinterErrors: true,
    preserveDecorations: true,
    decorationTimeout: 5000,
};

export const STREAM_EVENT_TYPES = {
    START: 'start',
    MODEL_PREPARATION: 'model_preparation',
    MODEL_REQUEST: 'model_request',
    MODEL_STREAMING: 'model_streaming',
    MODEL_OUTPUT: 'model_output',
    CODE_GENERATION_START: 'code_generation_start',
    CODE_CHUNK: 'code_chunk',
    CODE_GENERATION_COMPLETE: 'code_generation_complete',
    COMPLETION: 'completion',
    ERROR: 'error',
} as const; 