import * as vscode from 'vscode';
import { ApplyManager } from '../core/ApplyManager';
import { ApplyRequest, LinterError } from '../types/apply.types';

export interface ApplyApiRequest {
    filePath: string;
    codeSnippet: string;
    explanation?: string;
}

export interface ApplyApiResponse {
    success: boolean;
    message: string;
    linterErrors?: LinterError[];
}

export class ApplyApiHandler {
    private applyManager: ApplyManager;
    private outputChannel: vscode.OutputChannel;

    constructor(context?: vscode.ExtensionContext) {
        this.applyManager = new ApplyManager({}, context); // Pass extension context for hidden backup storage
        this.outputChannel = vscode.window.createOutputChannel('Apply Feature');

        // Setup event listeners
        this.setupEventListeners();
    }

    /**
     * Handle apply request from MCP server
     * This method will be called by the ContextApiServer when MCP makes a request
     */
    async handleApplyRequest(requestBody: ApplyApiRequest): Promise<ApplyApiResponse> {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply request received for file: ${requestBody.filePath}`);

        try {
            // Validate request
            if (!requestBody.filePath || !requestBody.codeSnippet) {
                throw new Error('Missing required fields: filePath and codeSnippet');
            }

            // Convert to internal request format
            const applyRequest: ApplyRequest = {
                filePath: requestBody.filePath,
                codeSnippet: requestBody.codeSnippet,
                explanation: requestBody.explanation,
            };

            // Execute the apply operation
            const result = await this.applyManager.applyCodeToFile(applyRequest);

            // Log the result
            this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            if (result.linterErrors && result.linterErrors.length > 0) {
                this.outputChannel.appendLine(`[${new Date().toISOString()}] Linter errors found: ${result.linterErrors.length}`);
            }

            // Convert to API response format
            return {
                success: result.success,
                message: result.message,
                linterErrors: result.linterErrors,
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply failed: ${errorMessage}`);

            return {
                success: false,
                message: errorMessage,
                linterErrors: [],
            };
        }
    }

    /**
     * Get apply status
     */
    getApplyStatus(): {
        inProgress: boolean;
        hasBackup: boolean;
        backupPath: string | null;
    } {
        return this.applyManager.getOperationStatus();
    }

    /**
     * Cancel current apply operation
     */
    cancelApplyOperation(): void {
        this.applyManager.cancelCurrentOperation();
        this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply operation cancelled by user`);
    }

    /**
     * Test connection to FastAPI server
     */
    async testConnection(): Promise<boolean> {
        try {
            const isConnected = await this.applyManager.testConnection();
            this.outputChannel.appendLine(`[${new Date().toISOString()}] FastAPI connection test: ${isConnected ? 'SUCCESS' : 'FAILED'}`);
            return isConnected;
        } catch (error) {
            this.outputChannel.appendLine(`[${new Date().toISOString()}] FastAPI connection test failed: ${error}`);
            return false;
        }
    }

    /**
     * Get apply configuration
     */
    getApplyConfig(): any {
        return this.applyManager.getConfig();
    }

    /**
     * Update apply configuration
     */
    updateApplyConfig(newConfig: any): void {
        this.applyManager.updateConfig(newConfig);
        this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply configuration updated`);
    }

    /**
     * Clear all decorations from active editor
     */
    clearDecorations(): void {
        this.applyManager.clearAllDecorations();
        this.outputChannel.appendLine(`[${new Date().toISOString()}] All decorations cleared`);
    }

    /**
     * Get apply statistics
     */
    getApplyStatistics(): {
        totalRequests: number;
        successfulRequests: number;
        failedRequests: number;
        averageProcessingTime: number;
    } {
        // This would be implemented with proper metrics collection
        // For now, returning placeholder data
        return {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageProcessingTime: 0,
        };
    }

    /**
     * Setup event listeners for apply operations
     */
    private setupEventListeners(): void {
        // Listen to apply events
        this.applyManager.onEvent(event => {
            switch (event.type) {
                case 'apply_start':
                    this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply started for: ${event.filePath}`);
                    break;

                case 'apply_progress':
                    this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply progress: ${event.progress.message} (${event.progress.progress}%)`);
                    break;

                case 'apply_complete':
                    this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply completed for: ${event.filePath} - Success: ${event.success}`);
                    if (event.linterErrors.length > 0) {
                        this.outputChannel.appendLine(`[${new Date().toISOString()}] Linter errors: ${event.linterErrors.length}`);
                        event.linterErrors.forEach(error => {
                            this.outputChannel.appendLine(`  - Line ${error.line}: ${error.message} (${error.source})`);
                        });
                    }
                    break;

                case 'apply_error':
                    this.outputChannel.appendLine(`[${new Date().toISOString()}] Apply error for: ${event.filePath} - ${event.error.message}`);
                    break;
            }
        });
    }

    /**
     * Show output channel
     */
    showOutputChannel(): void {
        this.outputChannel.show();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.applyManager.dispose();
        this.outputChannel.dispose();
    }
}

// Lazy singleton instance for use in ContextApiServer
let _applyApiHandlerInstance: ApplyApiHandler | null = null;

export function getApplyApiHandler(context?: vscode.ExtensionContext): ApplyApiHandler {
    if (!_applyApiHandlerInstance) {
        _applyApiHandlerInstance = new ApplyApiHandler(context);
    }
    return _applyApiHandlerInstance;
}

// Keep backward compatibility
export const applyApiHandler = getApplyApiHandler(); 