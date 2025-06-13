import * as vscode from 'vscode';
import { StatusIndicator } from '../decorations/StatusIndicator';
import { FileUpdateService } from '../services/FileUpdateService';
import { HttpClient } from '../services/HttpClient';
import { LinterService } from '../services/LinterService';
import {
    AppliedChange,
    ApplyConfig,
    ApplyEvent,
    ApplyRequest,
    ApplyResponse,
    DEFAULT_APPLY_CONFIG,
    HttpClientConfig,
    IApplyManager,
    LinterError,
    ProgressState
} from '../types/apply.types';
import { DiffRenderer } from './DiffRenderer';
import { StreamProcessor } from './StreamProcessor';

export class ApplyManager implements IApplyManager {
    private config: ApplyConfig;
    private httpClient: HttpClient;
    private fileUpdateService: FileUpdateService;
    private linterService: LinterService;
    private streamProcessor: StreamProcessor;
    private diffRenderer: DiffRenderer;
    private statusIndicator: StatusIndicator;

    private _isOperationInProgress: boolean = false;
    private currentBackupPath: string | null = null;
    private disposables: vscode.Disposable[] = [];
    private eventEmitter = new vscode.EventEmitter<ApplyEvent>();

    constructor(config: Partial<ApplyConfig> = {}, context?: vscode.ExtensionContext) {
        this.config = { ...DEFAULT_APPLY_CONFIG, ...config };

        // Initialize services
        this.httpClient = new HttpClient(this.getHttpClientConfig());
        this.fileUpdateService = new FileUpdateService(context); // Pass extension context for hidden storage
        this.linterService = new LinterService();
        this.streamProcessor = new StreamProcessor();
        this.diffRenderer = new DiffRenderer();
        this.statusIndicator = new StatusIndicator();

        this.setupStreamProcessor();
    }

    /**
     * Main method to apply code to a file
     */
    async applyCodeToFile(request: ApplyRequest): Promise<ApplyResponse> {
        if (this._isOperationInProgress) {
            throw new Error('Another apply operation is already in progress');
        }

        this._isOperationInProgress = true;
        this.currentBackupPath = null;

        try {
            // Validate request
            this.validateRequest(request);

            // Ensure file exists, create if not
            const fileExists = await this.fileUpdateService.fileExists(request.filePath);
            if (!fileExists) {
                await this.fileUpdateService.createFileWithDirs(request.filePath);
            }

            // Emit start event
            this.emitEvent({
                type: 'apply_start',
                filePath: request.filePath,
                timestamp: Date.now(),
            });

            // Show status indicator
            this.statusIndicator.show('Applying changes...', 'sync~spin');

            // Step 1: Read current file content
            const originalContent = await this.fileUpdateService.readFileContent(request.filePath);

            // Step 2: Create backup
            if (this.config.preserveDecorations) {
                this.currentBackupPath = await this.fileUpdateService.createBackup(request.filePath);
            }

            // Step 3: Get editor for visual feedback
            const editor = await this.getEditorForFile(request.filePath);

            // Step 4: Start streaming process
            const streamedContent = await this.processStreamingRequest(
                originalContent,
                request.codeSnippet,
                request.filePath,
                editor
            );

            // **FIX: Complete the apply operation immediately, don't wait for user decision**
            // Step 5: Apply content to file (this is the streamed result)
            await this.fileUpdateService.writeFileContent(request.filePath, streamedContent);

            // Step 6: Collect linter errors after apply
            const linterErrors = await this.collectLinterErrors(request.filePath);

            // Step 7: Show diff with accept/reject controls (non-blocking)
            if (editor) {
                // Show diff UI but don't wait for user decision
                this.showDiffWithFileControls(
                    editor,
                    originalContent,
                    streamedContent,
                    request.filePath
                );
            }

            // Step 8: Update status and return immediately
            this.statusIndicator.update('Apply completed - Review changes', 'check');
            setTimeout(() => this.statusIndicator.hide(), 3000);

            // Emit completion event
            this.emitEvent({
                type: 'apply_complete',
                filePath: request.filePath,
                success: true,
                linterErrors,
                timestamp: Date.now(),
            });

            // **FIX: Return response immediately to agent**
            return {
                success: true,
                message: 'Code applied successfully.',
                linterErrors,
                appliedChanges: this.generateAppliedChanges(originalContent, streamedContent),
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

            // Try to restore from backup if available
            if (this.currentBackupPath) {
                try {
                    await this.fileUpdateService.restoreFromBackup(request.filePath, this.currentBackupPath);
                } catch (restoreError) {
                    console.error('Failed to restore from backup:', restoreError);
                }
            }

            // Update status
            this.statusIndicator.update('Apply failed', 'error');
            setTimeout(() => this.statusIndicator.hide(), 5000);

            // Emit error event
            this.emitEvent({
                type: 'apply_error',
                filePath: request.filePath,
                error: error instanceof Error ? error : new Error(errorMessage),
                timestamp: Date.now(),
            });

            return {
                success: false,
                message: errorMessage,
                linterErrors: [],
            };

        } finally {
            this._isOperationInProgress = false;
            this.currentBackupPath = null;
        }
    }

    /**
     * Cancel the current operation
     */
    cancelCurrentOperation(): void {
        if (this._isOperationInProgress) {
            this.streamProcessor.cancel();
            this.httpClient.cancel();
            this.statusIndicator.update('Operation cancelled', 'stop');
            setTimeout(() => this.statusIndicator.hide(), 3000);
        }
    }

    /**
     * Check if operation is in progress
     */
    isOperationInProgress(): boolean {
        return this._isOperationInProgress;
    }

    /**
     * Process streaming request
     */
    private async processStreamingRequest(
        originalContent: string,
        codeSnippet: string,
        filePath: string,
        editor: vscode.TextEditor | null
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let accumulatedContent = '';

            // Setup progress tracking
            this.streamProcessor.onProgress((progress: ProgressState) => {
                this.statusIndicator.update(progress.message, 'sync~spin');

                // Emit progress event
                this.emitEvent({
                    type: 'apply_progress',
                    filePath,
                    progress,
                    timestamp: Date.now(),
                });
            });

            // Setup error handling
            this.streamProcessor.onError((error: Error) => {
                reject(error);
            });

            // Start the streaming request
            this.httpClient.streamEditFile(
                originalContent,
                codeSnippet,
                // On chunk received
                async (event) => {
                    if (event.type === 'code_chunk' && event.content) {
                        accumulatedContent += event.content;

                        // **FIX #1: Apply progressive streaming to the file**
                        if (editor) {
                            try {
                                // **CORRECTED: Replace entire content with accumulated content**
                                // This ensures we show the complete streamed content so far
                                const edit = new vscode.WorkspaceEdit();
                                const fullRange = new vscode.Range(
                                    editor.document.positionAt(0),
                                    editor.document.positionAt(editor.document.getText().length)
                                );

                                // Replace with accumulated content (this is the complete streamed content so far)
                                edit.replace(editor.document.uri, fullRange, accumulatedContent);

                                // Apply the edit to the file
                                await vscode.workspace.applyEdit(edit);

                                // Show streaming decoration on newly added lines
                                const lineCount = accumulatedContent.split('\n').length;
                                const lastFewLines = Math.max(1, lineCount - 3); // Highlight last few lines
                                const linesToHighlight = Array.from(
                                    { length: Math.min(3, lineCount) },
                                    (_, i) => lastFewLines + i
                                );

                                this.diffRenderer.highlightStreamingLines(editor, linesToHighlight);

                                // Brief flash to show streaming activity
                                setTimeout(() => {
                                    this.diffRenderer.clearStreamingDecorations(editor);
                                }, 150);

                            } catch (error) {
                                console.warn('Failed to apply streaming chunk:', error);
                            }
                        }
                    }
                },
                // On error
                (error) => {
                    reject(error);
                },
                // On complete
                () => {
                    // Clear streaming decorations
                    if (editor) {
                        this.diffRenderer.clearStreamingDecorations(editor);
                    }
                    resolve(accumulatedContent);
                }
            );
        });
    }

    /**
     * Get or open editor for file
     */
    private async getEditorForFile(filePath: string): Promise<vscode.TextEditor | null> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
            return editor;
        } catch (error) {
            console.warn('Failed to get editor for file:', error);
            return null;
        }
    }

    /**
     * Collect linter errors for the file
     */
    private async collectLinterErrors(filePath: string): Promise<LinterError[]> {
        if (!this.config.autoCollectLinterErrors) {
            return [];
        }

        try {
            // Wait a 2 second delay to ensure linters have processed the file after changes
            await this.delay(2000);

            const uri = vscode.Uri.file(filePath);

            // Get all errors but filter to only include severity "error"
            const allErrors = await this.linterService.collectErrors(uri);
            const errorSeverityOnly = allErrors.filter(error => error.severity === 'error');

            return errorSeverityOnly.map(error => ({ ...error, file: filePath }));
        } catch (error) {
            console.warn('Failed to collect linter errors:', error);
            return [];
        }
    }

    /**
     * Utility method for delays
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Generate applied changes summary
     */
    private generateAppliedChanges(originalContent: string, newContent: string): AppliedChange[] {
        const diff = this.diffRenderer.calculateDiff(originalContent, newContent);
        const changes: AppliedChange[] = [];

        diff.additions.forEach(line => {
            changes.push({
                type: 'addition',
                lineNumber: line.lineNumber,
                content: line.content,
            });
        });

        diff.deletions.forEach(line => {
            changes.push({
                type: 'deletion',
                lineNumber: line.lineNumber,
                content: line.content,
                originalContent: line.content,
            });
        });

        diff.modifications.forEach(line => {
            changes.push({
                type: 'modification',
                lineNumber: line.lineNumber,
                content: line.content,
            });
        });

        return changes;
    }

    /**
     * Validate apply request
     */
    private validateRequest(request: ApplyRequest): void {
        if (!request.filePath) {
            throw new Error('File path is required');
        }

        if (!request.codeSnippet) {
            throw new Error('Code snippet is required');
        }

        if (!this.fileUpdateService.validateFilePath(request.filePath)) {
            throw new Error('Invalid file path or file not in workspace');
        }
    }

    /**
     * Setup stream processor callbacks
     */
    private setupStreamProcessor(): void {
        // Additional setup can be done here if needed
    }

    /**
     * Get HTTP client configuration
     */
    private getHttpClientConfig(): HttpClientConfig {
        return {
            baseUrl: this.config.fastApiUrl,
            timeout: this.config.streamingTimeout,
            retryCount: this.config.maxRetries,
            retryDelay: this.config.debounceDelay,
        };
    }

    /**
     * Emit events
     */
    private emitEvent(event: ApplyEvent): void {
        this.eventEmitter.fire(event);
    }

    /**
     * Subscribe to events
     */
    get onEvent(): vscode.Event<ApplyEvent> {
        return this.eventEmitter.event;
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<ApplyConfig>): void {
        this.config = { ...this.config, ...newConfig };
        this.httpClient.updateConfig(this.getHttpClientConfig());
    }

    /**
     * Get current configuration
     */
    getConfig(): ApplyConfig {
        return { ...this.config };
    }

    /**
     * Test connection to FastAPI
     */
    async testConnection(): Promise<boolean> {
        return this.httpClient.testConnection();
    }

    /**
     * Get operation status
     */
    getOperationStatus(): {
        inProgress: boolean;
        hasBackup: boolean;
        backupPath: string | null;
    } {
        return {
            inProgress: this._isOperationInProgress,
            hasBackup: this.currentBackupPath !== null,
            backupPath: this.currentBackupPath,
        };
    }

    /**
     * Get backup storage statistics
     */
    async getBackupStats(): Promise<{
        backupDir: string;
        totalBackups: number;
        totalSize: number;
        oldestBackup: Date | null;
        newestBackup: Date | null;
    }> {
        return await this.fileUpdateService.getBackupStats();
    }

    /**
     * Clear all active decorations
     */
    clearAllDecorations(): void {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            this.diffRenderer.clearDiff(activeEditor);
        }
    }

    /**
     * Dispose all resources
     */
    dispose(): void {
        // Cancel any in-progress operation
        this.cancelCurrentOperation();

        // Dispose services
        this.fileUpdateService.dispose();
        this.linterService.dispose();
        this.diffRenderer.dispose();
        this.statusIndicator.dispose();

        // Dispose event emitter
        this.eventEmitter.dispose();

        // Dispose registered disposables
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
    }

    /**
     * **IMPROVED: Show diff with file-specific controls - offers both inline decorations and native diff view**
     */
    private showDiffWithFileControls(
        editor: vscode.TextEditor,
        originalContent: string,
        streamedContent: string,
        filePath: string
    ): void {
        // Calculate diff for inline decorations
        const diff = this.diffRenderer.calculateDiff(originalContent, streamedContent);

        // Show inline decorations with color highlighting (primary approach)
        this.diffRenderer.renderDiff(editor, diff);

        // Also show VSCode's native diff view in a side panel (fixed - no .original files)
        this.diffRenderer.showVSCodeDiff(originalContent, streamedContent, filePath);

        // Add file-specific accept/reject buttons
        this.diffRenderer.addFileControls(
            editor,
            filePath,
            async (accepted: boolean) => {
                if (accepted) {
                    // User accepted - changes are already applied, just clear diff decorations
                    this.diffRenderer.clearDiff(editor);
                    this.statusIndicator.update('Changes accepted', 'check');
                } else {
                    // User rejected - restore original content and clear decorations
                    await this.fileUpdateService.writeFileContent(filePath, originalContent);
                    this.diffRenderer.clearDiff(editor);
                    this.statusIndicator.update('Changes rejected - original restored', 'discard');
                }

                // Clear file controls for this file (buttons) 
                this.diffRenderer.clearFileControls(editor, filePath);

                setTimeout(() => this.statusIndicator.hide(), 2000);
            }
        );
    }
} 