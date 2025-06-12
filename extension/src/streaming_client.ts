import axios from 'axios';
import * as vscode from 'vscode';
import { getSystemInfo } from './utilities';

// Event types from the TRUE streaming API
interface StreamEvent {
    type: string;
    content: string;
    metadata?: Record<string, any>;
    timestamp: number;
}

interface SystemInfo {
    platform: string;
    osVersion: string;
    architecture: string;
    workspacePath: string;
    defaultShell: string;
}

interface ActiveFileContext {
    path?: string;
    relativePath?: string;
    languageId?: string;
    lineCount?: number;
    fileSize?: number;
    lastModified?: string;
    content?: string;
    cursorPosition?: {
        line: number;
        character: number;
    };
    selection?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    visibleRanges?: Array<{
        start: { line: number; character: number };
        end: { line: number; character: number };
    }>;
    cursorLineContent?: {
        current: string;
        above?: string;
        below?: string;
    };
}

interface QueryRequest {
    query: string;
    workspace_path: string;
    hashed_workspace_path: string;
    git_branch: string;
    system_info?: SystemInfo;
    active_file_context?: ActiveFileContext;
    open_files_context?: any[];
    context_mentions?: string[];
    recent_edits_context?: any;
}

interface ThinkingState {
    isThinking: boolean;
    content: string;
    startTime?: number;
}

interface ToolState {
    name?: string;
    arguments?: Record<string, any>;
    status: 'selecting' | 'executing' | 'completed' | 'error';
    result?: string;
    startTime?: number;
    endTime?: number;
}

interface TerminalState {
    command?: string;
    output: string;
    isExecuting: boolean;
    hasError: boolean;
    startTime?: number;
    endTime?: number;
}

interface StreamingState {
    thinking: ThinkingState;
    currentTool: ToolState | null;
    terminal: TerminalState;
    response: string;
    isComplete: boolean;
    hasError: boolean;
    errorMessage?: string;
}

export class EnhancedStreamingClient {
    private baseUrl: string;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;
    private currentState: StreamingState = {
        thinking: {
            isThinking: false,
            content: ""
        },
        currentTool: null,
        terminal: {
            output: "",
            isExecuting: false,
            hasError: false
        },
        response: "",
        isComplete: false,
        hasError: false
    };

    constructor(
        baseUrl: string = "http://0.0.0.0:5001", //192.168.17.182
        outputChannel: vscode.OutputChannel,
        statusBarItem: vscode.StatusBarItem
    ) {
        this.baseUrl = baseUrl;
        this.outputChannel = outputChannel;
        this.statusBarItem = statusBarItem;
        this.resetState();
    }

    private resetState(): void {
        this.currentState = {
            thinking: {
                isThinking: false,
                content: ""
            },
            currentTool: null,
            terminal: {
                output: "",
                isExecuting: false,
                hasError: false
            },
            response: "",
            isComplete: false,
            hasError: false
        };
    }

    async streamQuery(
        request: QueryRequest,
        webview?: vscode.Webview,
        onEvent?: (event: StreamEvent, state: StreamingState) => void | Promise<void>,
        headers?: Record<string, string>
    ): Promise<void> {
        try {
            // Reset state for new query
            this.resetState();

            // Get system information and add to request if not already provided
            if (!request.system_info) {
                const systemInfo = await getSystemInfo();
                request.system_info = systemInfo;
            }

            // Prepare headers with workspace ID if available from vscode workspace
            const requestHeaders = {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                ...headers // Include any additional headers passed in (including X-Workspace-ID)
            };

            // Show initial status
            this.updateStatus("🚀 Starting TRUE streaming...");
            this.appendToOutput(`\n=== NEW QUERY ===`);
            this.appendToOutput(`Query: ${request.query}`);
            if (request.active_file_context?.relativePath) {
                this.appendToOutput(`Active file: ${request.active_file_context.relativePath}`);
            }
            if (request.open_files_context && request.open_files_context.length > 0) {
                this.appendToOutput(`Open files: ${request.open_files_context.length} files`);
            }
            this.appendToOutput(`Workspace: ${request.system_info?.workspacePath || 'unknown'}`);
            this.appendToOutput(`Platform: ${request.system_info?.platform} ${request.system_info?.osVersion}`);
            this.appendToOutput(`Shell: ${request.system_info?.defaultShell}`);
            this.appendToOutput(`Timestamp: ${new Date().toLocaleString()}`);
            this.appendToOutput(`=================\n`);

            // Send initial message to webview with system info
            if (webview) {
                webview.postMessage({
                    command: 'streamStart',
                    query: request.query,
                    activeFile: request.active_file_context?.relativePath,
                    openFilesCount: request.open_files_context?.length || 0,
                    systemInfo: request.system_info,
                    state: this.currentState
                });
            }

            // Use axios with responseType 'stream' for TRUE streaming
            const response = await axios.post(`${this.baseUrl}/stream`, request, {
                headers: requestHeaders,
                responseType: 'stream',
                timeout: 300000 // 5 minutes timeout for long operations
            });

            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Handle the TRUE streaming response
            let buffer = '';
            let eventCount = 0;

            response.data.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');

                // Keep the last incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData: StreamEvent = JSON.parse(line.slice(6));
                            eventCount++;

                            // Handle the event and update state
                            this.handleStreamEvent(eventData, webview).catch(error => {
                                console.error('Error handling stream event:', error);
                                this.appendToOutput(`❌ Event handling error: ${error}`);
                            });

                            // Call custom event handler if provided
                            if (onEvent) {
                                Promise.resolve(onEvent(eventData, this.currentState)).catch(error => {
                                    console.error('Error in custom event handler:', error);
                                });
                            }
                        } catch (error) {
                            console.error('Failed to parse event data:', error);
                            this.appendToOutput(`❌ Parse error: ${error}`);
                            this.appendToOutput(`Raw line: ${line}`);
                        }
                    }
                }
            });

            response.data.on('end', () => {
                this.currentState.isComplete = true;
                this.updateStatus("✅ Streaming complete");
                this.appendToOutput(`\n=== STREAM COMPLETE ===`);
                this.appendToOutput(`Total events processed: ${eventCount}`);
                this.appendToOutput(`Final response length: ${this.currentState.response.length} characters`);
                this.appendToOutput(`=======================\n`);

                if (webview) {
                    webview.postMessage({
                        command: 'streamComplete',
                        state: this.currentState,
                        eventCount: eventCount
                    });
                }
            });

            response.data.on('error', (error: Error) => {
                this.currentState.hasError = true;
                this.currentState.errorMessage = error.message;
                throw error;
            });

            // Return a promise that resolves when the stream ends
            return new Promise((resolve, reject) => {
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });

        } catch (error) {
            console.error('TRUE Streaming error:', error);
            this.currentState.hasError = true;
            this.currentState.errorMessage = error instanceof Error ? error.message : String(error);
            this.updateStatus("❌ Streaming error");

            // Enhanced error logging for debugging API contract issues
            this.appendToOutput(`❌ ERROR: ${error}`);

            if (error instanceof Error && error.message.includes('422')) {
                this.appendToOutput(`❌ 422 ERROR DETAILS: This indicates a request validation error`);
                this.appendToOutput(`❌ Request payload that was rejected:`);
                this.appendToOutput(`❌ ${JSON.stringify(request, null, 2)}`);
                this.appendToOutput(`❌ The Python API expects exactly these fields:`);
                this.appendToOutput(`❌ SystemInfo: platform, osVersion, architecture, workspacePath, defaultShell`);
                this.appendToOutput(`❌ ActiveFileContext: path, relativePath, languageId, lineCount, fileSize, lastModified, content, cursorPosition, selection, visibleRanges, cursorLineContent`);
            }

            if (webview) {
                webview.postMessage({
                    command: 'streamError',
                    error: this.currentState.errorMessage,
                    state: this.currentState
                });
            }

            throw error;
        }
    }

    private async handleStreamEvent(event: StreamEvent, webview?: vscode.Webview): Promise<void> {
        const { type, content, metadata } = event;
        const timestamp = new Date(event.timestamp * 1000).toLocaleTimeString();

        // Log all events for debugging
        this.appendToOutput(`[${timestamp}] ${type.toUpperCase()}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
        if (metadata && Object.keys(metadata).length > 0) {
            this.appendToOutput(`[${timestamp}] METADATA: ${JSON.stringify(metadata, null, 2)}`);
        }

        switch (type) {
            case 'thinking':
                await this.handleThinkingEvent(content, metadata, webview, timestamp);
                break;

            case 'assistant_response':
                await this.handleAssistantResponseEvent(content, metadata, webview, timestamp);
                break;

            case 'tool_selection':
                await this.handleToolSelectionEvent(content, metadata, webview, timestamp);
                break;

            case 'tool_execution':
                await this.handleToolExecutionEvent(content, metadata, webview, timestamp);
                break;

            case 'tool_result':
                await this.handleToolResultEvent(content, metadata, webview, timestamp);
                break;

            case 'permission_request':
                await this.handlePermissionRequestEvent(content, metadata, webview, timestamp);
                break;

            case 'terminal_output':
                await this.handleTerminalOutputEvent(content, metadata, webview, timestamp);
                break;

            case 'final_response':
                await this.handleFinalResponseEvent(content, metadata, webview, timestamp);
                break;

            case 'error':
                await this.handleErrorEvent(content, metadata, webview, timestamp);
                break;

            default:
                this.appendToOutput(`[${timestamp}] UNHANDLED EVENT TYPE: ${type}`);
                break;
        }

        // Always send state update to webview
        if (webview) {
            webview.postMessage({
                command: 'stateUpdate',
                state: this.currentState,
                lastEvent: { type, content, metadata, timestamp }
            });
        }
    }

    private async handleThinkingEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        if (content === "Assistant is reasoning...") {
            // Start of thinking
            this.currentState.thinking.isThinking = true;
            this.currentState.thinking.startTime = Date.now();
            this.currentState.thinking.content = "";
            this.updateStatus("🧠 Agent is thinking...");
        } else if (content.includes("Generating response") || content.includes("Processing")) {
            // System thinking messages
            this.updateStatus(`🤔 ${content}`);
        } else {
            // Actual thinking content (streaming)
            this.currentState.thinking.content += content;
            this.updateStatus(`🧠 Thinking... (${this.currentState.thinking.content.length} chars)`);
        }

        if (webview) {
            webview.postMessage({
                command: 'thinking',
                content: content,
                fullThinking: this.currentState.thinking.content,
                isThinking: this.currentState.thinking.isThinking
            });
        }
    }

    private async handleAssistantResponseEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        // Stop thinking when response starts
        if (this.currentState.thinking.isThinking) {
            this.currentState.thinking.isThinking = false;
            const thinkingDuration = this.currentState.thinking.startTime ?
                Date.now() - this.currentState.thinking.startTime : 0;
            this.appendToOutput(`[${timestamp}] THINKING COMPLETE: ${thinkingDuration}ms, ${this.currentState.thinking.content.length} chars`);
        }

        // Accumulate response content
        this.currentState.response += content;
        this.updateStatus(`💬 Responding... (${this.currentState.response.length} chars)`);

        if (webview) {
            webview.postMessage({
                command: 'responseUpdate',
                content: content,
                fullResponse: this.currentState.response
            });
        }
    }

    private async handleToolSelectionEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        const toolName = metadata?.tool_name || 'unknown';

        this.currentState.currentTool = {
            name: toolName,
            status: 'selecting',
            startTime: Date.now()
        };

        this.updateStatus(`🔧 Selected tool: ${toolName}`);
        this.appendToOutput(`[${timestamp}] TOOL SELECTED: ${toolName}`);

        if (webview) {
            webview.postMessage({
                command: 'toolSelection',
                toolName: toolName,
                content: content,
                metadata: metadata
            });
        }
    }

    private async handleToolExecutionEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        const toolName = metadata?.tool_name || this.currentState.currentTool?.name || 'unknown';
        const toolArguments = metadata?.tool_arguments || {};

        if (this.currentState.currentTool) {
            this.currentState.currentTool.status = 'executing';
            this.currentState.currentTool.arguments = toolArguments;
        }

        this.updateStatus(`⚙️ Executing ${toolName}...`);
        this.appendToOutput(`[${timestamp}] TOOL EXECUTING: ${toolName}`);
        this.appendToOutput(`[${timestamp}] TOOL ARGUMENTS:`);
        this.appendToOutput(JSON.stringify(toolArguments, null, 2));

        if (webview) {
            webview.postMessage({
                command: 'toolExecution',
                toolName: toolName,
                arguments: toolArguments,
                content: content,
                metadata: metadata
            });
        }
    }

    private async handleToolResultEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        const toolName = metadata?.tool_name || this.currentState.currentTool?.name || 'unknown';
        const isError = metadata?.error || false;
        const resultLength = metadata?.result_length || content.length;

        if (this.currentState.currentTool) {
            this.currentState.currentTool.status = isError ? 'error' : 'completed';
            this.currentState.currentTool.result = content;
            this.currentState.currentTool.endTime = Date.now();

            const duration = this.currentState.currentTool.startTime ?
                this.currentState.currentTool.endTime - this.currentState.currentTool.startTime : 0;

            this.appendToOutput(`[${timestamp}] TOOL ${isError ? 'ERROR' : 'COMPLETED'}: ${toolName} (${duration}ms)`);
            this.appendToOutput(`[${timestamp}] RESULT LENGTH: ${resultLength} characters`);
        }

        this.updateStatus(isError ? `❌ Tool error: ${toolName}` : `✅ Tool completed: ${toolName}`);

        // Special handling for terminal commands - send terminal output event
        if (toolName === 'run_terminal_command') {
            // Update terminal state
            this.currentState.terminal.output = content;
            this.currentState.terminal.isExecuting = false;
            this.currentState.terminal.hasError = isError;
            this.currentState.terminal.endTime = Date.now();

            if (webview) {
                webview.postMessage({
                    command: 'terminalOutput',
                    content: content,
                    terminalCommand: this.currentState.terminal.command,
                    output: content,
                    isExecuting: false,
                    hasError: isError,
                    metadata: metadata
                });
            }
        }

        if (webview) {
            webview.postMessage({
                command: 'toolResult',
                toolName: toolName,
                content: content,
                isError: isError,
                resultLength: resultLength,
                metadata: metadata
            });
        }
    }

    private async handlePermissionRequestEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        const command = metadata?.command;
        const permissionId = metadata?.permission_id;

        // Update terminal state with the command to be executed
        this.currentState.terminal = {
            command: command,
            output: "",
            isExecuting: false,
            hasError: false,
            startTime: Date.now()
        };

        this.updateStatus(`⚠️ Permission required`);
        this.appendToOutput(`[${timestamp}] PERMISSION REQUEST: ${command}`);
        this.appendToOutput(`[${timestamp}] PERMISSION ID: ${permissionId}`);

        if (webview) {
            webview.postMessage({
                command: 'permissionRequest',
                content: content,
                terminalCommand: command,
                permissionId: permissionId,
                metadata: metadata
            });
        }
    }

    private async handleTerminalOutputEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        const isError = metadata?.error || false;
        const isComplete = metadata?.complete || false;

        // Update terminal state
        this.currentState.terminal.output += content;
        this.currentState.terminal.isExecuting = !isComplete;
        this.currentState.terminal.hasError = isError;

        if (isComplete) {
            this.currentState.terminal.endTime = Date.now();
            const duration = this.currentState.terminal.startTime ?
                this.currentState.terminal.endTime - this.currentState.terminal.startTime : 0;

            this.updateStatus(isError ?
                `❌ Terminal command failed (${duration}ms)` :
                `✅ Terminal command completed (${duration}ms)`);

            this.appendToOutput(`[${timestamp}] TERMINAL COMMAND COMPLETED: ${this.currentState.terminal.command} (${duration}ms)`);
        } else {
            this.updateStatus(`⚙️ Executing terminal command...`);
            this.appendToOutput(`[${timestamp}] TERMINAL OUTPUT: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
        }

        if (webview) {
            webview.postMessage({
                command: 'terminalOutput',
                content: content,
                fullOutput: this.currentState.terminal.output,
                isError: isError,
                isComplete: isComplete,
                metadata: metadata
            });
        }
    }

    private async handleFinalResponseEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        this.currentState.response = content; // Final complete response
        this.currentState.isComplete = true;

        this.updateStatus("✅ Response complete");
        this.appendToOutput(`[${timestamp}] FINAL RESPONSE: ${content.length} characters`);

        if (webview) {
            webview.postMessage({
                command: 'streamComplete',
                content: content,
                metadata: metadata
            });
        }
    }

    private async handleErrorEvent(content: string, metadata: any, webview?: vscode.Webview, timestamp?: string): Promise<void> {
        this.currentState.hasError = true;
        this.currentState.errorMessage = content;

        this.updateStatus("❌ Error occurred");
        this.appendToOutput(`[${timestamp}] ERROR: ${content}`);

        if (webview) {
            webview.postMessage({
                command: 'streamError',
                error: content,
                metadata: metadata
            });
        }
    }

    private updateStatus(text: string): void {
        this.statusBarItem.text = `$(plug) ${text}`;
    }

    private appendToOutput(text: string): void {
        this.outputChannel.appendLine(text);
    }

    async sendPermissionResponse(permissionId: string, granted: boolean): Promise<void> {
        try {
            // Update terminal state if permission is granted
            if (granted && this.currentState.terminal.command) {
                this.currentState.terminal.isExecuting = true;
            }

            const response = await axios.post(`${this.baseUrl}/permission`, {
                permission_id: permissionId,
                granted: granted
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 300000
            });

            this.appendToOutput(`[PERMISSION] Response sent: ${granted ? 'GRANTED' : 'DENIED'} for ${permissionId}`);
            this.appendToOutput(`[PERMISSION] Server response: ${JSON.stringify(response.data)}`);

            // If permission denied, reset terminal state
            if (!granted) {
                this.currentState.terminal = {
                    command: this.currentState.terminal.command,
                    output: "Permission denied by user",
                    isExecuting: false,
                    hasError: true,
                    startTime: this.currentState.terminal.startTime,
                    endTime: Date.now()
                };
            }
        } catch (error) {
            this.appendToOutput(`[PERMISSION] Error sending response: ${error}`);
            throw error;
        }
    }

    async checkHealth(): Promise<boolean> {
        try {
            const response = await axios.post(`${this.baseUrl}/health`, {}, {
                timeout: 5000
            });

            const isHealthy = response.data?.status === 'healthy';
            const isStreaming = response.data?.streaming === true;

            this.appendToOutput(`[HEALTH] Status: ${response.data?.status}, Streaming: ${isStreaming}`);

            return isHealthy && isStreaming;
        } catch (error) {
            this.appendToOutput(`[HEALTH] Check failed: ${error}`);
            return false;
        }
    }

    getCurrentState(): StreamingState {
        return { ...this.currentState };
    }

    resetCurrentState(): void {
        this.resetState();
    }
} 