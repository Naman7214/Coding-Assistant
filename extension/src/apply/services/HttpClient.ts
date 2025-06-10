import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { HttpClientConfig, StreamEvent } from '../types/apply.types';

// Remove node-fetch and use Node.js built-in fetch (Node 18+)
// If Node < 18, we'll use EventSource or XMLHttpRequest alternative

export class HttpClient {
    private config: HttpClientConfig;
    private abortController: AbortController | null = null;

    constructor(config: HttpClientConfig) {
        this.config = config;
    }

    /**
     * Make a streaming request to the FastAPI edit-file endpoint
     */
    async streamEditFile(
        targetFileContent: string,
        codeSnippet: string,
        onChunk: (event: StreamEvent) => void,
        onError: (error: Error) => void,
        onComplete: () => void
    ): Promise<void> {
        this.abortController = new AbortController();

        const payload = {
            target_file_content: targetFileContent,
            code_snippet: codeSnippet
        };

        const url = `${this.config.baseUrl}/api/v1/edit-file`;

        try {
            // Use Node.js HTTP/HTTPS for better SSE compatibility in VSCode extension environment
            await this.makeSSERequest(url, payload, onChunk, onError, onComplete);

        } catch (error) {
            if (error instanceof Error) {
                if (error.name === 'AbortError' || error.message.includes('cancelled')) {
                    console.log('Stream request was cancelled');
                } else {
                    onError(error);
                }
            } else {
                onError(new Error('Unknown error occurred during streaming'));
            }
        }
    }

    /**
     * Make SSE request using Node.js HTTP/HTTPS for better compatibility
     */
    private makeSSERequest(
        url: string,
        payload: any,
        onChunk: (event: StreamEvent) => void,
        onError: (error: Error) => void,
        onComplete: () => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const isHttps = parsedUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const postData = JSON.stringify(payload);

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: this.config.timeout,
            };

            const req = httpModule.request(options, (res) => {
                let buffer = '';

                // Handle data chunks
                res.on('data', (chunk) => {
                    buffer += chunk.toString();

                    // Process complete SSE messages
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer

                    for (const line of lines) {
                        if (line.trim() === '') continue;

                        // Parse SSE format: "data: {json}"
                        if (line.startsWith('data: ')) {
                            const jsonData = line.substring(6);
                            try {
                                const event: StreamEvent = JSON.parse(jsonData);
                                onChunk(event);
                            } catch (parseError) {
                                console.warn('Failed to parse SSE event:', jsonData, parseError);
                                // Continue processing other events instead of failing completely
                            }
                        }
                    }
                });

                // Handle end of response
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        onComplete();
                        resolve();
                    } else {
                        const error = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
                        onError(error);
                        reject(error);
                    }
                });

                // Handle response errors
                res.on('error', (error) => {
                    onError(error);
                    reject(error);
                });
            });

            // Handle request errors
            req.on('error', (error) => {
                onError(error);
                reject(error);
            });

            // Handle timeout
            req.on('timeout', () => {
                const error = new Error('Request timed out');
                req.destroy();
                onError(error);
                reject(error);
            });

            // Handle cancellation
            if (this.abortController) {
                this.abortController.signal.addEventListener('abort', () => {
                    req.destroy();
                    resolve();
                });
            }

            // Send the request
            req.write(postData);
            req.end();
        });
    }

    /**
     * Cancel the current streaming request
     */
    cancel(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Make a simple POST request (non-streaming)
     */
    async post<T>(endpoint: string, data: any): Promise<T> {
        const url = `${this.config.baseUrl}${endpoint}`;

        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.config.retryCount; attempt++) {
            try {
                const response = await this.makeJsonRequest('POST', url, data);
                return response as T;

            } catch (error) {
                lastError = error instanceof Error ? error : new Error('Unknown error');

                if (attempt < this.config.retryCount) {
                    await this.delay(this.config.retryDelay * attempt);
                }
            }
        }

        throw lastError || new Error('All retry attempts failed');
    }

    /**
     * Make a simple GET request
     */
    async get<T>(endpoint: string): Promise<T> {
        const url = `${this.config.baseUrl}${endpoint}`;
        const response = await this.makeJsonRequest('GET', url);
        return response as T;
    }

    /**
     * Make a JSON request using Node.js HTTP/HTTPS
     */
    private makeJsonRequest(method: string, url: string, data?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const isHttps = parsedUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const postData = data ? JSON.stringify(data) : '';

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    ...(data && { 'Content-Length': Buffer.byteLength(postData) }),
                },
                timeout: this.config.timeout,
            };

            const req = httpModule.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk.toString();
                });

                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const response = JSON.parse(responseData);
                            resolve(response);
                        } catch (error) {
                            reject(new Error('Failed to parse JSON response'));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    }
                });

                res.on('error', (error) => {
                    reject(error);
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });

            if (data) {
                req.write(postData);
            }
            req.end();
        });
    }

    /**
     * Test connection to the FastAPI server
     */
    async testConnection(): Promise<boolean> {
        try {
            await this.makeJsonRequest('GET', `${this.config.baseUrl}/health`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Utility method for delays
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current configuration
     */
    getConfig(): HttpClientConfig {
        return { ...this.config };
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<HttpClientConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Check if a request is currently in progress
     */
    isRequestInProgress(): boolean {
        return this.abortController !== null;
    }
} 