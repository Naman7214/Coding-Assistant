import React, { useEffect, useRef, useState } from 'react';
import './SimpleApp.css';

// Declare vscode API
declare const vscode: any;

interface ToolUsage {
    name: string;
    description: string;
    status: 'running' | 'completed' | 'error';
    timestamp: number;
}

interface ChatMessage {
    id: string;
    type: 'user' | 'assistant';
    content: string;
    timestamp: number;
    tools?: ToolUsage[];
    isStreaming?: boolean;
}

interface PermissionRequest {
    id: string;
    message: string;
    command: string;
    isBackground?: boolean;
}

interface TerminalOutput {
    command: string;
    output: string;
    isExecuting: boolean;
    hasError: boolean;
}

interface ContextMention {
    type: 'problems' | 'project-structure' | 'git' | 'open-files';
    label: string;
}

const CONTEXT_MENTIONS: ContextMention[] = [
    { type: 'problems', label: '@problems' },
    { type: 'project-structure', label: '@project' },
    { type: 'git', label: '@git' },
    { type: 'open-files', label: '@files' }
];

const SimpleApp: React.FC = () => {
    const [query, setQuery] = useState('');
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const [currentResponse, setCurrentResponse] = useState('');
    const [currentTools, setCurrentTools] = useState<ToolUsage[]>([]);
    const [showContextMenu, setShowContextMenu] = useState(false);
    const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
    const [filteredContexts, setFilteredContexts] = useState<ContextMention[]>([]);
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
    const [terminalOutput, setTerminalOutput] = useState<TerminalOutput | null>(null);

    const inputRef = useRef<HTMLTextAreaElement>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Listen for messages from the extension
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;

            switch (message.command) {
                case 'streamStart':
                    handleStreamStart();
                    break;
                case 'toolSelection':
                    handleToolUpdate(message);
                    break;
                case 'toolExecution':
                    handleToolUpdate(message);
                    break;
                case 'responseUpdate':
                    handleResponseUpdate(message);
                    break;
                case 'streamComplete':
                    handleStreamComplete();
                    break;
                case 'streamError':
                    handleStreamError(message);
                    break;
                case 'permissionRequest':
                    handlePermissionRequest(message);
                    break;
                case 'terminalOutput':
                    handleTerminalOutput(message);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory, currentResponse]);

    const handleStreamStart = () => {
        setIsStreaming(true);
        setCurrentResponse('');
        setCurrentTools([]);
        setPermissionRequest(null);
        setTerminalOutput(null);
    };

    const handleToolUpdate = (message: any) => {
        const toolName = message.toolName || message.content;
        const status = message.type === 'toolSelection' ? 'running' : 'completed';

        // Create simple tool descriptions like Cursor
        const getToolDescription = (name: string): string => {
            if (name.includes('list') || name.includes('directory')) return 'listing files';
            if (name.includes('grep') || name.includes('search')) return 'searched codebase';
            if (name.includes('read') || name.includes('file')) return 'reading file';
            if (name.includes('write') || name.includes('edit')) return 'editing file';
            if (name.includes('terminal') || name.includes('command')) return 'running command';
            if (name.includes('git')) return 'checking git status';
            if (name.includes('problems') || name.includes('diagnostic')) return 'checking problems';
            return name.toLowerCase();
        };

        setCurrentTools(prev => {
            const existing = prev.find(t => t.name === toolName);
            if (existing) {
                return prev.map(t =>
                    t.name === toolName
                        ? { ...t, status, timestamp: Date.now() }
                        : t
                );
            } else {
                return [...prev, {
                    name: toolName,
                    description: getToolDescription(toolName),
                    status,
                    timestamp: Date.now()
                }];
            }
        });
    };

    const handleResponseUpdate = (message: any) => {
        setCurrentResponse(prev => prev + (message.content || ''));
    };

    const handleStreamComplete = () => {
        setIsStreaming(false);

        // Add the complete message to chat history
        const assistantMessage: ChatMessage = {
            id: Date.now().toString(),
            type: 'assistant',
            content: currentResponse,
            timestamp: Date.now(),
            tools: [...currentTools]
        };

        setChatHistory(prev => [...prev, assistantMessage]);
        setCurrentResponse('');
        setCurrentTools([]);
        setPermissionRequest(null);
        setTerminalOutput(null);
    };

    const handleStreamError = (message: any) => {
        setIsStreaming(false);
        const errorMessage: ChatMessage = {
            id: Date.now().toString(),
            type: 'assistant',
            content: `Error: ${message.error || 'Something went wrong'}`,
            timestamp: Date.now()
        };
        setChatHistory(prev => [...prev, errorMessage]);
        setCurrentResponse('');
        setCurrentTools([]);
        setPermissionRequest(null);
        setTerminalOutput(null);
    };

    const handlePermissionRequest = (message: any) => {
        setPermissionRequest({
            id: message.permissionId,
            message: message.content || 'Permission required to execute command',
            command: message.terminalCommand || message.metadata?.command || '',
            isBackground: message.metadata?.is_background || false
        });
    };

    const handleTerminalOutput = (message: any) => {
        setTerminalOutput({
            command: message.terminalCommand || message.command || '',
            output: message.output || message.content || '',
            isExecuting: message.isExecuting || false,
            hasError: message.hasError || false
        });
    };

    const handlePermissionResponse = (granted: boolean) => {
        if (!permissionRequest) return;

        // Send response to extension
        vscode.postMessage({
            command: 'permissionResponse',
            permissionId: permissionRequest.id,
            granted: granted
        });

        if (granted) {
            // Initialize terminal output for approved command
            setTerminalOutput({
                command: permissionRequest.command,
                output: 'Executing command...',
                isExecuting: true,
                hasError: false
            });
        }

        setPermissionRequest(null);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setQuery(value);

        // Check for @ mentions
        const atIndex = value.lastIndexOf('@');
        if (atIndex !== -1 && atIndex === value.length - 1) {
            // Just typed @, show all contexts
            setFilteredContexts(CONTEXT_MENTIONS);
            setShowContextMenu(true);
            setContextMenuPosition({ x: 0, y: -120 });
        } else if (atIndex !== -1 && atIndex < value.length - 1) {
            // Typing after @, filter contexts
            const searchTerm = value.substring(atIndex + 1).toLowerCase();
            const filtered = CONTEXT_MENTIONS.filter(ctx =>
                ctx.label.toLowerCase().includes(searchTerm) ||
                ctx.type.toLowerCase().includes(searchTerm)
            );
            setFilteredContexts(filtered);
            setShowContextMenu(filtered.length > 0);
        } else {
            setShowContextMenu(false);
        }
    };

    const handleContextSelect = (context: ContextMention) => {
        const atIndex = query.lastIndexOf('@');
        if (atIndex !== -1) {
            const beforeAt = query.substring(0, atIndex);
            setQuery(beforeAt + context.label + ' ');
        }
        setShowContextMenu(false);
        inputRef.current?.focus();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (showContextMenu) {
            if (e.key === 'Escape') {
                setShowContextMenu(false);
                return;
            }
            if (e.key === 'Enter' && filteredContexts.length > 0) {
                e.preventDefault();
                handleContextSelect(filteredContexts[0]);
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleSubmit = () => {
        if (query.trim() && !isStreaming) {
            // Add user message to chat
            const userMessage: ChatMessage = {
                id: Date.now().toString(),
                type: 'user',
                content: query.trim(),
                timestamp: Date.now()
            };

            setChatHistory(prev => [...prev, userMessage]);

            // Send to extension
            vscode.postMessage({
                command: 'sendQuery',
                text: query.trim()
            });

            setQuery('');
            setShowContextMenu(false);
        }
    };

    const formatTimestamp = (timestamp: number) => {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const renderMessage = (message: ChatMessage) => {
        return (
            <div key={message.id} className={`message ${message.type}`}>
                <div className="message-content">
                    {message.content}
                </div>
                {message.tools && message.tools.length > 0 && (
                    <div className="message-tools">
                        {message.tools.map((tool, index) => (
                            <div key={index} className={`tool-item ${tool.status}`}>
                                <span className="tool-icon">
                                    {tool.status === 'running' ? '⏳' :
                                        tool.status === 'completed' ? '✓' : '❌'}
                                </span>
                                <span className="tool-description">{tool.description}</span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="message-timestamp">
                    {formatTimestamp(message.timestamp)}
                </div>
            </div>
        );
    };

    return (
        <div className="simple-app">
            <div className="chat-container">
                <div className="chat-messages">
                    {chatHistory.map(renderMessage)}

                    {/* Current streaming response */}
                    {isStreaming && (
                        <div className="message assistant streaming">
                            {currentTools.length > 0 && (
                                <div className="current-tools">
                                    {currentTools.map((tool, index) => (
                                        <div key={index} className={`tool-item ${tool.status}`}>
                                            <span className="tool-icon">
                                                {tool.status === 'running' ? '⏳' : '✓'}
                                            </span>
                                            <span className="tool-description">{tool.description}</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Terminal output display */}
                            {terminalOutput && (
                                <div className="terminal-output">
                                    <div className="terminal-header">
                                        <span className="terminal-icon">$</span>
                                        <span className="terminal-command">{terminalOutput.command}</span>
                                        {terminalOutput.isExecuting && (
                                            <span className="terminal-status executing">⏳ Executing...</span>
                                        )}
                                    </div>
                                    <div className={`terminal-content ${terminalOutput.hasError ? 'error' : ''}`}>
                                        <pre>{terminalOutput.output}</pre>
                                    </div>
                                </div>
                            )}

                            <div className="message-content">
                                {currentResponse}
                                <span className="cursor-blink">|</span>
                            </div>
                        </div>
                    )}

                    <div ref={chatEndRef} />
                </div>
            </div>

            <div className="input-container">
                <div className="input-wrapper">
                    <textarea
                        ref={inputRef}
                        className="message-input"
                        placeholder="Ask anything... Use @ for context"
                        value={query}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        disabled={isStreaming}
                        rows={1}
                    />

                    <button
                        className="send-button"
                        onClick={handleSubmit}
                        disabled={!query.trim() || isStreaming}
                    >
                        {isStreaming ? '⏳' : '➤'}
                    </button>

                    {/* Context menu */}
                    {showContextMenu && (
                        <div
                            className="context-menu"
                            style={{
                                bottom: contextMenuPosition.y,
                                left: contextMenuPosition.x
                            }}
                        >
                            {filteredContexts.map((context, index) => (
                                <div
                                    key={context.type}
                                    className="context-menu-item"
                                    onClick={() => handleContextSelect(context)}
                                >
                                    <span className="context-icon">@</span>
                                    <span className="context-label">{context.type}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Permission Dialog Modal */}
            {permissionRequest && (
                <div className="permission-modal-overlay">
                    <div className="permission-modal">
                        <div className="permission-header">
                            <h3>⚠️ Permission Required</h3>
                        </div>
                        <div className="permission-content">
                            <p className="permission-message">{permissionRequest.message}</p>
                            <div className="permission-command-container">
                                <div className="permission-command-label">Command:</div>
                                <code className="permission-command">{permissionRequest.command}</code>
                            </div>
                            {permissionRequest.isBackground && (
                                <div className="permission-background-note">
                                    ⚠️ This command will run in the background
                                </div>
                            )}
                        </div>
                        <div className="permission-actions">
                            <button
                                className="permission-button deny-button"
                                onClick={() => handlePermissionResponse(false)}
                            >
                                Deny
                            </button>
                            <button
                                className="permission-button allow-button"
                                onClick={() => handlePermissionResponse(true)}
                            >
                                Allow
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SimpleApp; 