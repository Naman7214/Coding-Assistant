import React, { useEffect, useRef, useState } from 'react';
import './SimpleApp.css';

// Declare vscode API
declare const vscode: any;

interface ConversationItem {
    id: string;
    type: 'user' | 'thinking' | 'tool' | 'response';
    content: string;
    metadata?: any;
    timestamp: number;
    isStreaming?: boolean;
}

interface PermissionRequest {
    id: string;
    message: string;
    command: string;
    isBackground?: boolean;
}

const SimpleApp: React.FC = () => {
    const [query, setQuery] = useState('');
    const [items, setItems] = useState<ConversationItem[]>([]);
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [pendingQuery, setPendingQuery] = useState('');

    const inputRef = useRef<HTMLTextAreaElement>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            console.log('[UI] Received:', message.command, message);

            switch (message.command) {
                case 'streamStart':
                    handleStreamStart(message);
                    break;
                case 'thinking':
                    handleThinking(message.content);
                    break;
                case 'toolSelection':
                    handleToolSelection(message);
                    break;
                case 'toolExecution':
                    handleToolExecution(message);
                    break;
                case 'toolResult':
                    handleToolResult(message);
                    break;
                case 'responseUpdate':
                    handleResponseUpdate(message.content);
                    break;
                case 'streamComplete':
                    handleStreamComplete(message.content);
                    break;
                case 'streamError':
                    handleStreamError(message.error);
                    break;
                case 'permissionRequest':
                    handlePermissionRequest(message);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);

        // Debug: Log when component mounts
        console.log('[UI] SimpleApp component mounted, waiting for messages...');

        return () => window.removeEventListener('message', handleMessage);
    }, []);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        console.log('[UI] Items updated, count:', items.length, 'types:', items.map(i => i.type));
    }, [items]);

    const handleStreamStart = (message?: any) => {
        const queryText = message?.query || pendingQuery || query;
        console.log('[UI] Stream started for:', queryText);
        setIsStreaming(true);
        setPermissionRequest(null);

        // Add user message
        const userItem: ConversationItem = {
            id: `user-${Date.now()}`,
            type: 'user',
            content: queryText,
            timestamp: Date.now()
        };

        setItems(prev => [...prev, userItem]);
    };

    const handleThinking = (content: string) => {
        console.log('[UI] Thinking received:', content.substring(0, 100), '...');

        // Skip system thinking messages that aren't actual content
        if (content.includes('Processing your request') ||
            content.includes('Generating response') ||
            content.includes('Starting to process') ||
            content.trim().length === 0) {
            console.log('[UI] Skipping system thinking message');
            return;
        }

        setItems(prev => {
            const newItems = [...prev];
            const lastItem = newItems[newItems.length - 1];

            // If last item is thinking and streaming, append content
            if (lastItem && lastItem.type === 'thinking' && lastItem.isStreaming) {
                lastItem.content += content;
                console.log('[UI] Appended to thinking, total chars:', lastItem.content.length);
            } else {
                // Create new thinking item
                const thinkingItem: ConversationItem = {
                    id: `thinking-${Date.now()}`,
                    type: 'thinking',
                    content: content,
                    timestamp: Date.now(),
                    isStreaming: true
                };
                newItems.push(thinkingItem);
                console.log('[UI] New thinking item created with:', content.substring(0, 50));
            }

            return newItems;
        });
    };

    const handleToolSelection = (message: any) => {
        console.log('[UI] Tool selection:', message);
        const toolName = message.metadata?.tool_name || 'unknown';
        const friendlyName = message.metadata?.friendly_name || toolName;

        setItems(prev => {
            const newItems = [...prev];

            // Mark last thinking as complete
            if (newItems.length > 0 && newItems[newItems.length - 1].type === 'thinking') {
                newItems[newItems.length - 1].isStreaming = false;
            }

            // Add tool item
            const toolItem: ConversationItem = {
                id: `tool-${Date.now()}`,
                type: 'tool',
                content: getCleanToolName(toolName, friendlyName),
                metadata: { toolName, status: 'selected' },
                timestamp: Date.now(),
                isStreaming: true
            };
            newItems.push(toolItem);

            return newItems;
        });
    };

    const handleToolExecution = (message: any) => {
        console.log('[UI] Tool execution:', message);
        const toolName = message.metadata?.tool_name || 'unknown';
        const friendlyName = message.metadata?.friendly_name || toolName;

        setItems(prev => {
            const newItems = [...prev];
            const lastTool = newItems.reverse().find(item =>
                item.type === 'tool' && item.metadata?.toolName === toolName
            );

            if (lastTool) {
                lastTool.content = getCleanToolName(toolName, friendlyName);
                lastTool.metadata = { ...lastTool.metadata, status: 'executing' };
            }

            return newItems.reverse();
        });
    };

    const handleToolResult = (message: any) => {
        console.log('[UI] Tool result:', message);
        const toolName = message.metadata?.tool_name || 'unknown';
        const isError = message.metadata?.error || false;

        setItems(prev => {
            const newItems = [...prev];
            const lastTool = newItems.reverse().find(item =>
                item.type === 'tool' && item.metadata?.toolName === toolName
            );

            if (lastTool) {
                lastTool.metadata = { ...lastTool.metadata, status: isError ? 'error' : 'completed' };
                lastTool.isStreaming = false;
            }

            return newItems.reverse();
        });
    };

    const handleResponseUpdate = (content: string) => {
        console.log('[UI] Response update:', content.substring(0, 50));

        setItems(prev => {
            const newItems = [...prev];

            // Mark last thinking as complete when response starts (but keep it visible)
            const lastThinking = newItems.reverse().find(item => item.type === 'thinking' && item.isStreaming);
            if (lastThinking) {
                lastThinking.isStreaming = false;
                console.log('[UI] Marked thinking as complete, keeping visible');
            }
            newItems.reverse();

            const lastItem = newItems[newItems.length - 1];

            // If last item is response and streaming, append content
            if (lastItem && lastItem.type === 'response' && lastItem.isStreaming) {
                lastItem.content += content;
                console.log('[UI] Appended to response, total chars:', lastItem.content.length);
            } else {
                // Create new response item
                const responseItem: ConversationItem = {
                    id: `response-${Date.now()}`,
                    type: 'response',
                    content: content,
                    timestamp: Date.now(),
                    isStreaming: true
                };
                newItems.push(responseItem);
                console.log('[UI] New response item created');
            }

            return newItems;
        });
    };

    const handleStreamComplete = (finalContent?: string) => {
        console.log('[UI] Stream complete');

        setItems(prev => {
            const newItems = [...prev];

            // Mark all items as complete
            newItems.forEach(item => {
                item.isStreaming = false;
            });

            // Update final response if provided
            if (finalContent) {
                const lastResponse = newItems.reverse().find(item => item.type === 'response');
                if (lastResponse) {
                    lastResponse.content = finalContent;
                }
                newItems.reverse();
            }

            return newItems;
        });

        setIsStreaming(false);
        setPendingQuery('');
    };

    const handleStreamError = (error: string) => {
        console.log('[UI] Stream error:', error);

        const errorItem: ConversationItem = {
            id: `error-${Date.now()}`,
            type: 'response',
            content: `Error: ${error}`,
            metadata: { isError: true },
            timestamp: Date.now()
        };

        setItems(prev => [...prev, errorItem]);
        setIsStreaming(false);
        setPendingQuery('');
    };

    const handlePermissionRequest = (message: any) => {
        console.log('[UI] Permission request:', message);
        setPermissionRequest({
            id: message.permissionId,
            message: message.content || 'Permission required to execute command',
            command: message.terminalCommand || message.metadata?.command || '',
            isBackground: message.metadata?.is_background || false
        });
    };

    const handlePermissionResponse = (granted: boolean) => {
        if (!permissionRequest) return;

        console.log('[UI] Permission response:', granted);
        vscode.postMessage({
            command: 'permissionResponse',
            permissionId: permissionRequest.id,
            granted: granted
        });

        setPermissionRequest(null);
    };

    const getCleanToolName = (toolName: string, friendlyName: string): string => {
        // Clean, minimal tool descriptions like Cursor IDE Chat interface
        const cleanNames: Record<string, string> = {
            'list_directory': 'List files',
            'read_file': 'Read file',
            'edit_file': 'Edit file',
            'search_files': 'Search codebase',
            'run_terminal_command': 'Run command',
            'create_file': 'Create file',
            'delete_file': 'Delete file',
        };

        return cleanNames[toolName] || friendlyName || toolName;
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setQuery(value);

        // Auto-resize textarea
        const textarea = e.target;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleSubmit = () => {
        if (query.trim() && !isStreaming) {
            console.log('[UI] Submitting:', query.trim());

            // Store the query before sending
            setPendingQuery(query.trim());

            // Send to extension
            vscode.postMessage({
                command: 'sendQuery',
                text: query.trim()
            });

            setQuery('');

            // Reset textarea height
            if (inputRef.current) {
                inputRef.current.style.height = 'auto';
            }
        }
    };

    const renderItem = (item: ConversationItem) => {
        const { type, content, isStreaming, metadata } = item;

        // Debug rendering
        console.log('[UI] Rendering item:', type, 'streaming:', isStreaming, 'content length:', content.length);

        switch (type) {
            case 'user':
                return (
                    <div key={item.id} className="conversation-item user-item">
                        <div className="item-header">
                            <span className="item-role">You</span>
                        </div>
                        <div className="item-content user-content">
                            {content}
                        </div>
                    </div>
                );

            case 'thinking':
                return (
                    <div key={item.id} className="conversation-item thinking-item">
                        <div className="item-header">
                            <span className="thinking-icon">💭</span>
                            <span className="item-label">Thinking</span>
                            {isStreaming && <span className="streaming-cursor">|</span>}
                        </div>
                        <div className="item-content thinking-content">
                            {content}
                        </div>
                    </div>
                );

            case 'tool':
                const status = metadata?.status || 'selected';
                const statusIcon = status === 'completed' ? '✓' : status === 'error' ? '✗' : status === 'executing' ? '...' : '';

                return (
                    <div key={item.id} className={`conversation-item tool-item tool-${status}`}>
                        <div className="item-header">
                            <span className="tool-icon">🔧</span>
                            <span className="item-label">{content} {statusIcon}</span>
                            {isStreaming && status === 'executing' && <span className="streaming-cursor">⏳</span>}
                        </div>
                    </div>
                );

            case 'response':
                return (
                    <div key={item.id} className={`conversation-item response-item ${metadata?.isError ? 'error' : ''}`}>
                        <div className="item-content response-content">
                            {content}
                            {isStreaming && <span className="streaming-cursor">|</span>}
                        </div>
                    </div>
                );

            default:
                return null;
        }
    };

    return (
        <div className="simple-app">
            <div className="chat-container">
                <div className="chat-messages">
                    {items.length === 0 && (
                        <div className="empty-state">
                            Ask anything to get started...
                        </div>
                    )}

                    {items.map(renderItem)}

                    <div ref={chatEndRef} />
                </div>
            </div>

            <div className="input-container">
                <div className="input-wrapper">
                    <textarea
                        ref={inputRef}
                        className="message-input"
                        placeholder="Ask anything..."
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
                </div>
            </div>

            {/* Permission Dialog */}
            {permissionRequest && (
                <div className="permission-modal-overlay">
                    <div className="permission-modal">
                        <div className="permission-header">
                            <h3>⚠️ Permission Required</h3>
                        </div>
                        <div className="permission-content">
                            <p>{permissionRequest.message}</p>
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