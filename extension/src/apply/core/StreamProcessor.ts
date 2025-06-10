import {
    CodeChunk,
    IStreamProcessor,
    ProgressState,
    STREAM_EVENT_TYPES,
    StreamEvent
} from '../types/apply.types';

export class StreamProcessor implements IStreamProcessor {
    private progressCallbacks: Array<(state: ProgressState) => void> = [];
    private errorCallbacks: Array<(error: Error) => void> = [];
    private isCancelled = false;
    private currentProgress: ProgressState = {
        stage: 'preparing',
        progress: 0,
        message: 'Preparing...',
        chunksProcessed: 0,
        totalChunks: 0,
        bytesProcessed: 0,
        totalBytes: 0,
    };

    /**
     * Process individual stream events (called by HttpClient)
     * This method processes events that come from the SSE stream
     */
    async processStreamEvent(event: StreamEvent, chunkIndex: number): Promise<{
        content: string;
        updateProgress: boolean;
    }> {
        let content = '';
        let updateProgress = false;

        switch (event.type) {
            case STREAM_EVENT_TYPES.START:
                this.updateProgress({
                    stage: 'preparing',
                    progress: 5,
                    message: 'Stream started...',
                    chunksProcessed: 0,
                    totalChunks: 0,
                    bytesProcessed: 0,
                    totalBytes: 0,
                });
                break;

            case STREAM_EVENT_TYPES.MODEL_PREPARATION:
                this.updateProgress({
                    stage: 'preparing',
                    progress: 15,
                    message: 'Preparing model...',
                    chunksProcessed: 0,
                    totalChunks: 0,
                    bytesProcessed: 0,
                    totalBytes: 0,
                });
                break;

            case STREAM_EVENT_TYPES.MODEL_REQUEST:
                this.updateProgress({
                    stage: 'streaming',
                    progress: 25,
                    message: 'Sending request to model...',
                    chunksProcessed: 0,
                    totalChunks: 0,
                    bytesProcessed: 0,
                    totalBytes: 0,
                });
                break;

            case STREAM_EVENT_TYPES.MODEL_STREAMING:
                this.updateProgress({
                    stage: 'streaming',
                    progress: 35,
                    message: 'Model is processing...',
                    chunksProcessed: chunkIndex,
                    totalChunks: 0,
                    bytesProcessed: 0,
                    totalBytes: 0,
                });
                break;

            case STREAM_EVENT_TYPES.CODE_GENERATION_START:
                this.updateProgress({
                    stage: 'streaming',
                    progress: 40,
                    message: 'Starting code generation...',
                    chunksProcessed: chunkIndex,
                    totalChunks: event.metadata.total_chunks_processed || 0,
                    bytesProcessed: 0,
                    totalBytes: event.metadata.total_code_length || 0,
                });
                break;

            case STREAM_EVENT_TYPES.CODE_CHUNK:
                // This is the main content
                content = event.content;
                updateProgress = true;

                this.updateProgress({
                    stage: 'applying',
                    progress: Math.min(95, 40 + (chunkIndex * 0.5)), // Progressive increase
                    message: `Processing chunk ${chunkIndex + 1}...`,
                    chunksProcessed: chunkIndex + 1,
                    totalChunks: event.metadata.total_chunks_processed || chunkIndex + 1,
                    bytesProcessed: event.metadata.chunk_number || 0,
                    totalBytes: event.metadata.total_code_length || 0,
                });
                break;

            case STREAM_EVENT_TYPES.CODE_GENERATION_COMPLETE:
                this.updateProgress({
                    stage: 'completing',
                    progress: 98,
                    message: 'Code generation completed...',
                    chunksProcessed: chunkIndex,
                    totalChunks: chunkIndex,
                    bytesProcessed: event.metadata.final_content_length || 0,
                    totalBytes: event.metadata.final_content_length || 0,
                });
                break;

            case STREAM_EVENT_TYPES.COMPLETION:
                this.updateProgress({
                    stage: 'completing',
                    progress: 100,
                    message: 'Stream processing completed',
                    chunksProcessed: chunkIndex,
                    totalChunks: chunkIndex,
                    bytesProcessed: event.metadata.final_content_length || 0,
                    totalBytes: event.metadata.final_content_length || 0,
                });
                break;

            case STREAM_EVENT_TYPES.ERROR:
                this.notifyError(new Error(event.content || 'Stream processing error'));
                break;

            default:
                console.warn('Unknown stream event type:', event.type);
                break;
        }

        return { content, updateProgress };
    }

    /**
     * Reset processing state for new operations
     */
    reset(): void {
        this.isCancelled = false;
        this.currentProgress = {
            stage: 'preparing',
            progress: 0,
            message: 'Preparing...',
            chunksProcessed: 0,
            totalChunks: 0,
            bytesProcessed: 0,
            totalBytes: 0,
        };
    }

    /**
     * Initialize stream processing (called before starting)
     */
    initialize(): void {
        this.reset();
        this.updateProgress({
            stage: 'preparing',
            progress: 0,
            message: 'Initializing stream processing...',
            chunksProcessed: 0,
            totalChunks: 0,
            bytesProcessed: 0,
            totalBytes: 0,
        });
    }

    /**
     * Complete stream processing
     */
    complete(): void {
        this.updateProgress({
            stage: 'completing',
            progress: 100,
            message: 'Stream processing completed successfully',
            chunksProcessed: this.currentProgress.chunksProcessed,
            totalChunks: this.currentProgress.totalChunks,
            bytesProcessed: this.currentProgress.bytesProcessed,
            totalBytes: this.currentProgress.totalBytes,
        });
    }

    /**
     * Register progress callback
     */
    onProgress(callback: (state: ProgressState) => void): void {
        this.progressCallbacks.push(callback);
    }

    /**
     * Register error callback
     */
    onError(callback: (error: Error) => void): void {
        this.errorCallbacks.push(callback);
    }

    /**
     * Cancel the stream processing
     */
    cancel(): void {
        this.isCancelled = true;
        this.updateProgress({
            stage: 'error',
            progress: this.currentProgress.progress,
            message: 'Stream processing cancelled',
            chunksProcessed: this.currentProgress.chunksProcessed,
            totalChunks: this.currentProgress.totalChunks,
            bytesProcessed: this.currentProgress.bytesProcessed,
            totalBytes: this.currentProgress.totalBytes,
        });
    }

    /**
     * Check if the operation is cancelled
     */
    isCancelledOperation(): boolean {
        return this.isCancelled;
    }

    /**
     * Update progress and notify callbacks
     */
    private updateProgress(newProgress: Partial<ProgressState>): void {
        this.currentProgress = {
            ...this.currentProgress,
            ...newProgress,
        };

        // Notify all progress callbacks
        this.progressCallbacks.forEach(callback => {
            try {
                callback(this.currentProgress);
            } catch (error) {
                console.error('Error in progress callback:', error);
            }
        });
    }

    /**
     * Notify error callbacks
     */
    private notifyError(error: Error): void {
        // Update progress to error state
        this.updateProgress({
            stage: 'error',
            message: `Error: ${error.message}`,
        });

        // Notify all error callbacks
        this.errorCallbacks.forEach(callback => {
            try {
                callback(error);
            } catch (callbackError) {
                console.error('Error in error callback:', callbackError);
            }
        });
    }

    /**
     * Utility method for delays
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current progress state
     */
    getCurrentProgress(): ProgressState {
        return { ...this.currentProgress };
    }

    /**
     * Clear all callbacks
     */
    clearCallbacks(): void {
        this.progressCallbacks = [];
        this.errorCallbacks = [];
    }

    /**
     * Create a code chunk object (utility method)
     */
    private createCodeChunk(content: string, lineNumber: number, chunkIndex: number, isInsideCodeBlock: boolean, totalLength: number): CodeChunk {
        return {
            content,
            lineNumber,
            chunkIndex,
            isInsideCodeBlock,
            totalLength,
        };
    }
} 