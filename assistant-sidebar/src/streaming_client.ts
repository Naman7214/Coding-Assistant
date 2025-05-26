import * as vscode from 'vscode';
import axios from 'axios';

// Event types from the streaming API
interface StreamEvent {
    type: string;
    content: string;
    metadata?: Record<string, any>;
    timestamp: number;
}

interface QueryRequest {
    query: string;
    target_file_path?: string;
}

export class AgentStreamingClient {
    private baseUrl: string;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;

    constructor(
        baseUrl: string = "http://192.168.17.182:5001",
        outputChannel: vscode.OutputChannel,
        statusBarItem: vscode.StatusBarItem
    ) {
        this.baseUrl = baseUrl;
        this.outputChannel = outputChannel;
        this.statusBarItem = statusBarItem;
    }

    async streamQuery(
        request: QueryRequest,
        webview?: vscode.Webview,
        onEvent?: (event: StreamEvent) => void | Promise<void>
    ): Promise<void> {
        try {
            // Show initial status
            this.updateStatus("🤔 Connecting to agent...");
            this.appendToOutput(`Starting query: ${request.query}`);

            // Send initial message to webview
            if (webview) {
                webview.postMessage({
                    command: 'streamStart',
                    query: request.query
                });
            }

            // Use axios with responseType 'stream' for streaming
            const response = await axios.post(`${this.baseUrl}/stream`, request, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                responseType: 'stream'
            });

            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Handle the stream
            let buffer = '';
            
            response.data.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                
                // Keep the last incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData: StreamEvent = JSON.parse(line.slice(6));
                            
                            // Handle the event
                            this.handleEvent(eventData, webview).catch(error => {
                                console.error('Error handling event:', error);
                                this.appendToOutput(`Event handling error: ${error}`);
                            });
                            
                            // Call custom event handler if provided
                            if (onEvent) {
                                Promise.resolve(onEvent(eventData)).catch(error => {
                                    console.error('Error in custom event handler:', error);
                                });
                            }
                        } catch (error) {
                            console.error('Failed to parse event data:', error);
                            this.appendToOutput(`Parse error: ${error}`);
                        }
                    }
                }
            });

            response.data.on('end', () => {
                // Clear status when done
                this.updateStatus("");
                this.appendToOutput("Query completed successfully");
            });

            response.data.on('error', (error: Error) => {
                throw error;
            });

            // Return a promise that resolves when the stream ends
            return new Promise((resolve, reject) => {
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });

        } catch (error) {
            console.error('Streaming error:', error);
            this.updateStatus("❌ Error");
            this.appendToOutput(`Error: ${error}`);
            
            if (webview) {
                webview.postMessage({
                    command: 'streamError',
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            
            throw error;
        }
    }

    private async handleEvent(event: StreamEvent, webview?: vscode.Webview): Promise<void> {
        const { type, content, metadata } = event;
        const timestamp = new Date(event.timestamp * 1000).toLocaleTimeString();

        switch (type) {
            case 'thinking':
                this.updateStatus(`🤔 ${content}`);
                this.appendToOutput(`[THINKING] ${content}`);
                
                if (webview) {
                    webview.postMessage({
                        command: 'streamEvent',
                        type: 'thinking',
                        content: content
                    });
                }
                break;

            case 'tool_selection':
                const toolName = metadata?.tool_name;
                this.updateStatus(`🔧 Using ${toolName}`);
                this.appendToOutput(`[TOOL] Selected: ${toolName}`);
                
                if (metadata?.tool_arguments) {
                    this.appendToOutput(`[TOOL] Arguments: ${JSON.stringify(metadata.tool_arguments, null, 2)}`);
                }

                if (webview) {
                    webview.postMessage({
                        command: 'streamEvent',
                        type: 'tool_selection',
                        content: `Using tool: ${toolName}`,
                        metadata: metadata
                    });
                }
                break;

            case 'tool_execution':
                if (metadata?.requires_permission) {
                    // Show permission dialog
                    const permission = await this.requestPermission(content);
                    if (!permission) {
                        this.appendToOutput(`[TOOL] Permission denied: ${content}`);
                        return;
                    }
                }
                
                this.updateStatus(`⚙️ Executing...`);
                this.appendToOutput(`[TOOL] ${content}`);

                if (webview) {
                    webview.postMessage({
                        command: 'streamEvent',
                        type: 'tool_execution',
                        content: content,
                        metadata: metadata
                    });
                }
                break;

            case 'tool_result':
                const isError = metadata?.error;
                const resultToolName = metadata?.tool_name;
                
                if (isError) {
                    this.appendToOutput(`[ERROR] Tool ${resultToolName} failed: ${content}`);
                    vscode.window.showErrorMessage(`Tool ${resultToolName} failed: ${content}`);
                } else {
                    this.appendToOutput(`[RESULT] Tool ${resultToolName} completed`);
                    
                    // Handle file edits specially
                    if (resultToolName === 'edit_file') {
                        await this.handleFileEdit(content, metadata);
                    }
                }

                if (webview) {
                    webview.postMessage({
                        command: 'streamEvent',
                        type: 'tool_result',
                        content: content,
                        metadata: metadata
                    });
                }
                break;

            case 'assistant_response':
                this.updateStatus(`🤖 Responding...`);
                this.appendToOutput(`[ASSISTANT] ${content}`);
                
                if (webview) {
                    webview.postMessage({
                        command: 'streamEvent',
                        type: 'assistant_response',
                        content: content
                    });
                }
                break;

            case 'final_response':
                this.updateStatus(`✅ Complete`);
                this.appendToOutput(`[COMPLETE] Response finished`);
                
                if (webview) {
                    webview.postMessage({
                        command: 'streamComplete',
                        content: content
                    });
                }
                
                // Clear status after a delay
                setTimeout(() => {
                    this.updateStatus('');
                }, 3000);
                break;

            case 'error':
                this.updateStatus(`❌ Error`);
                this.appendToOutput(`[ERROR] ${content}`);
                vscode.window.showErrorMessage(content);
                
                if (webview) {
                    webview.postMessage({
                        command: 'streamError',
                        error: content
                    });
                }
                break;

            default:
                this.appendToOutput(`[${type.toUpperCase()}] ${content}`);
                
                if (webview) {
                    webview.postMessage({
                        command: 'streamEvent',
                        type: type,
                        content: content,
                        metadata: metadata
                    });
                }
        }
    }

    private updateStatus(text: string): void {
        this.statusBarItem.text = text || '$(plug) Agent Server';
        this.statusBarItem.show();
    }

    private appendToOutput(text: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${text}`);
    }

    private async requestPermission(message: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            `Agent wants to execute: ${message}`,
            { modal: true },
            'Allow',
            'Deny'
        );
        
        return choice === 'Allow';
    }

    private async handleFileEdit(content: string, metadata: any): Promise<void> {
        const targetFile = metadata?.target_file;
        if (targetFile) {
            this.appendToOutput(`[FILE_EDIT] Modified: ${targetFile}`);
            
            try {
                // Open the modified file
                const doc = await vscode.workspace.openTextDocument(targetFile);
                await vscode.window.showTextDocument(doc);
                
                // Show notification
                vscode.window.showInformationMessage(
                    `File updated: ${require('path').basename(targetFile)}`
                );
            } catch (error) {
                this.appendToOutput(`[FILE_EDIT] Could not open file: ${error}`);
            }
        }
    }

    async checkHealth(): Promise<boolean> {
        try {
            const response = await axios.post(`${this.baseUrl}/health`, {}, {
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.status === 200) {
                return response.data.status === 'healthy';
            }
            return false;
        } catch (error) {
            return false;
        }
    }
} 