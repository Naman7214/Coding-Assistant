// TypeScript client for VSCode extensions to consume the streaming agent API

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

    constructor(baseUrl: string = "http://192.168.17.182:5001") {
        this.baseUrl = baseUrl;
    }

    async streamQuery(
        request: QueryRequest,
        onEvent?: (event: StreamEvent) => void | Promise<void>
    ): Promise<void> {
        try {
            const response = await fetch(`${this.baseUrl}/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('Failed to get response reader');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                
                // Keep the last incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData: StreamEvent = JSON.parse(line.slice(6));
                            
                            if (onEvent) {
                                await onEvent(eventData);
                            } else {
                                this.defaultEventHandler(eventData);
                            }
                        } catch (error) {
                            console.error('Failed to parse event data:', error);
                            console.error('Raw line:', line);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Streaming error:', error);
            throw error;
        }
    }

    private defaultEventHandler(event: StreamEvent): void {
        const timestamp = new Date(event.timestamp * 1000).toLocaleTimeString();
        
        switch (event.type) {
            case 'thinking':
                console.log(`🤔 [${timestamp}] Thinking: ${event.content}`);
                break;
            case 'tool_selection':
                console.log(`🔧 [${timestamp}] Selected tool: ${event.metadata?.tool_name}`);
                break;
            case 'tool_execution':
                console.log(`⚙️ [${timestamp}] ${event.content}`);
                break;
            case 'tool_result':
                const isError = event.metadata?.error;
                const icon = isError ? '❌' : '✅';
                console.log(`${icon} [${timestamp}] Tool result: ${event.content.substring(0, 100)}...`);
                break;
            case 'assistant_response':
                console.log(`🤖 [${timestamp}] Assistant: ${event.content}`);
                break;
            case 'final_response':
                console.log(`✨ [${timestamp}] Final response received`);
                break;
            case 'error':
                console.error(`💥 [${timestamp}] Error: ${event.content}`);
                break;
            default:
                console.log(`📝 [${timestamp}] ${event.type}: ${event.content}`);
        }
    }
}

// VSCode Extension Integration Example
export class VSCodeAgentIntegration {
    private client: AgentStreamingClient;
    private outputChannel: any; // vscode.OutputChannel
    private statusBarItem: any; // vscode.StatusBarItem
    private webviewPanel: any; // vscode.WebviewPanel

    constructor(
        outputChannel: any,
        statusBarItem: any,
        webviewPanel?: any
    ) {
        this.client = new AgentStreamingClient();
        this.outputChannel = outputChannel;
        this.statusBarItem = statusBarItem;
        this.webviewPanel = webviewPanel;
    }

    async processQuery(query: string, targetFilePath?: string): Promise<void> {
        const request: QueryRequest = {
            query,
            target_file_path: targetFilePath
        };

        await this.client.streamQuery(request, (event) => this.handleEvent(event));
    }

    private async handleEvent(event: StreamEvent): Promise<void> {
        const { type, content, metadata } = event;

        switch (type) {
            case 'thinking':
                this.updateStatus(`🤔 ${content}`);
                this.appendToOutput(`[THINKING] ${content}`);
                break;

            case 'tool_selection':
                const toolName = metadata?.tool_name;
                this.updateStatus(`🔧 Using ${toolName}`);
                this.appendToOutput(`[TOOL] Selected: ${toolName}`);
                
                // Show tool arguments in output
                if (metadata?.tool_arguments) {
                    this.appendToOutput(`[TOOL] Arguments: ${JSON.stringify(metadata.tool_arguments, null, 2)}`);
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
                break;

            case 'tool_result':
                const isError = metadata?.error;
                const resultToolName = metadata?.tool_name;
                
                if (isError) {
                    this.appendToOutput(`[ERROR] Tool ${resultToolName} failed: ${content}`);
                    this.showError(`Tool ${resultToolName} failed: ${content}`);
                } else {
                    this.appendToOutput(`[RESULT] Tool ${resultToolName} completed`);
                    
                    // For certain tools, show results in webview
                    if (this.shouldShowInWebview(resultToolName)) {
                        this.showInWebview(resultToolName, content);
                    }
                    
                    // For edit_file tool, show the changes
                    if (resultToolName === 'edit_file') {
                        this.handleFileEdit(content, metadata);
                    }
                }
                break;

            case 'assistant_response':
                this.updateStatus(`🤖 Responding...`);
                this.appendToOutput(`[ASSISTANT] ${content}`);
                
                // Stream to webview if available
                if (this.webviewPanel) {
                    this.streamToWebview(content);
                }
                break;

            case 'final_response':
                this.updateStatus(`✅ Complete`);
                this.appendToOutput(`[COMPLETE] Response finished`);
                
                // Clear status after a delay
                setTimeout(() => {
                    this.updateStatus('');
                }, 3000);
                break;

            case 'error':
                this.updateStatus(`❌ Error`);
                this.appendToOutput(`[ERROR] ${content}`);
                this.showError(content);
                break;
        }
    }

    private updateStatus(text: string): void {
        if (this.statusBarItem) {
            this.statusBarItem.text = text;
            this.statusBarItem.show();
        }
    }

    private appendToOutput(text: string): void {
        if (this.outputChannel) {
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] ${text}`);
        }
    }

    private async requestPermission(message: string): Promise<boolean> {
        // In a real VSCode extension, you'd use vscode.window.showWarningMessage
        // with modal options
        console.log(`Permission requested: ${message}`);
        return true; // For demo purposes, always grant permission
    }

    private showError(message: string): void {
        // In a real VSCode extension, you'd use vscode.window.showErrorMessage
        console.error(message);
    }

    private shouldShowInWebview(toolName: string): boolean {
        // Show certain tool results in webview
        return ['codebase_search', 'grep_search', 'read_file'].includes(toolName);
    }

    private showInWebview(toolName: string, content: string): void {
        if (!this.webviewPanel) return;

        // Send formatted content to webview
        this.webviewPanel.webview.postMessage({
            type: 'tool_result',
            toolName,
            content,
            timestamp: Date.now()
        });
    }

    private streamToWebview(content: string): void {
        if (!this.webviewPanel) return;

        this.webviewPanel.webview.postMessage({
            type: 'assistant_response',
            content,
            timestamp: Date.now()
        });
    }

    private handleFileEdit(content: string, metadata: any): void {
        // Handle file edit results
        const targetFile = metadata?.target_file;
        if (targetFile) {
            this.appendToOutput(`[FILE_EDIT] Modified: ${targetFile}`);
            
            // You could trigger file refresh, show diff, etc.
            // vscode.workspace.openTextDocument(targetFile).then(doc => {
            //     vscode.window.showTextDocument(doc);
            // });
        }
    }
}

// Usage example for VSCode extension
export function createAgentIntegration(context: any): VSCodeAgentIntegration {
    // In a real VSCode extension:
    // const outputChannel = vscode.window.createOutputChannel('Agent');
    // const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    
    const outputChannel = {
        appendLine: (text: string) => console.log(text)
    };
    
    const statusBarItem = {
        text: '',
        show: () => {},
        hide: () => {}
    };

    return new VSCodeAgentIntegration(outputChannel, statusBarItem);
}

// Example command handler for VSCode extension
export async function handleAgentQuery(
    integration: VSCodeAgentIntegration,
    query: string,
    activeFilePath?: string
): Promise<void> {
    try {
        await integration.processQuery(query, activeFilePath);
    } catch (error) {
        console.error('Agent query failed:', error);
        // vscode.window.showErrorMessage(`Agent query failed: ${error.message}`);
    }
} 