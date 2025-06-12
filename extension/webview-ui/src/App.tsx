import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import ContextAwareInput from './components/ContextAwareInput';
import ContextChips from './components/ContextChips';
import MarkdownRenderer from './components/MarkdownRenderer';
import { ContextChip } from './types/contextMentions';

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
    timeoutSeconds?: number;
    startTime?: number;
    friendlyName?: string;
}

interface StreamMessage {
    command: string;
    content?: string;
    metadata?: any;
    error?: string;
    query?: string;
    permissionId?: string;
    terminalCommand?: string;
}

const App: React.FC = () => {
    const [query, setQuery] = useState('');
    const [items, setItems] = useState<ConversationItem[]>([]);
    const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
    const [permissionTimeLeft, setPermissionTimeLeft] = useState<number>(0);
    const permissionTimerRef = useRef<NodeJS.Timeout | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [isStopped, setIsStopped] = useState(false);
    const [pendingQuery, setPendingQuery] = useState('');
    const [attachedContexts, setAttachedContexts] = useState<ContextChip[]>([]);
    const [contextSuggestions, setContextSuggestions] = useState<any[]>([]);

    const chatEndRef = useRef<HTMLDivElement>(null);

    // Context management functions
    const handleRemoveContext = (contextId: string) => {
        setAttachedContexts(prev => prev.filter(ctx => ctx.id !== contextId));
    };

    const handleContextSelected = useCallback((event: CustomEvent) => {
        const { type, display, originalMention, description } = event.detail;

        // Create a new context chip
        const newContext: ContextChip = {
            id: `${type}-${Date.now()}`,
            type: type,
            display: display,
            originalMention: originalMention,
            description: description
        };

        // Add to attached contexts if not already present
        setAttachedContexts(prev => {
            const exists = prev.some(ctx =>
                ctx.type === newContext.type && ctx.originalMention === newContext.originalMention
            );
            if (!exists) {
                return [...prev, newContext];
            }
            return prev;
        });
    }, []);

    // Helper function to handle streaming content deduplication
    const handleStreamingContent = (existingContent: string, newContent: string): string => {
        // If new content is empty, keep existing
        if (!newContent || newContent.trim().length === 0) {
            return existingContent;
        }

        // If existing content is empty, use new content
        if (!existingContent || existingContent.trim().length === 0) {
            return newContent;
        }

        // Check if new content is a complete replacement (contains all of existing + more)
        if (newContent.length > existingContent.length && newContent.includes(existingContent)) {
            console.log('[UI] Replacing content (complete replacement)');
            return newContent;
        }

        // Check if new content is a prefix that already exists (duplicate)
        if (existingContent.includes(newContent)) {
            console.log('[UI] Skipping duplicate content');
            return existingContent;
        }

        // Check for overlap at the end of existing content and beginning of new content
        let maxOverlap = Math.min(existingContent.length, newContent.length);
        let overlap = 0;

        for (let i = 1; i <= maxOverlap; i++) {
            if (existingContent.slice(-i) === newContent.slice(0, i)) {
                overlap = i;
            }
        }

        if (overlap > 0) {
            // Remove the overlapping part from new content and append
            const result = existingContent + newContent.slice(overlap);
            console.log('[UI] Handled overlap of', overlap, 'characters');
            return result;
        }

        // Default: simple append
        console.log('[UI] Simple append');
        return existingContent + newContent;
    };

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            console.log('[UI] Received event:', message.command, 'content length:', message.content?.length || 0, 'full message:', message);

            // If conversation was stopped by user, ignore all streaming messages
            if (isStopped && ['thinking', 'toolSelection', 'tool_selection', 'toolExecution', 'tool_execution', 'toolResult', 'tool_result', 'responseUpdate', 'assistant_response'].includes(message.command)) {
                console.log('[UI] Ignoring message due to user stop:', message.command);
                return;
            }

            switch (message.command) {
                case 'streamStart':
                    handleStreamStart(message);
                    break;
                case 'thinking':
                    handleThinking(message.content);
                    break;
                case 'toolSelection':
                case 'tool_selection':  // Handle backend event type
                    handleToolSelection(message);
                    break;
                case 'toolExecution':
                case 'tool_execution':  // Handle backend event type
                    handleToolExecution(message);
                    break;
                case 'toolResult':
                case 'tool_result':  // Handle backend event type
                    handleToolResult(message);
                    break;
                case 'responseUpdate':
                case 'assistant_response':  // Handle backend event type
                    handleResponseUpdate(message.content);
                    break;
                case 'streamComplete':
                case 'final_response':  // Handle backend event type
                    handleStreamComplete(message.content);
                    break;
                case 'streamError':
                case 'error':  // Handle backend event type
                    handleStreamError(message.error || message.content);
                    break;
                case 'permissionRequest':
                case 'permission_request':  // Handle backend event type
                    handlePermissionRequest(message);
                    break;
                case 'permissionTimeout':
                case 'permission_timeout':  // Handle backend event type
                    handlePermissionTimeout(message);
                    break;
                case 'contextSuggestions':
                    console.log('[UI] Received context suggestions:', message.suggestions);
                    setContextSuggestions(message.suggestions || []);
                    break;
                case 'fileTree':
                    console.log('[UI] Received file tree:', message.tree);
                    // Handle file tree if needed
                    break;
                default:
                    console.log('[UI] Unhandled message command:', message.command);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        window.addEventListener('contextSelected', handleContextSelected as EventListener);

        // Debug: Log when component mounts
        console.log('[UI] App component mounted, waiting for messages...');

        return () => {
            window.removeEventListener('message', handleMessage);
            window.removeEventListener('contextSelected', handleContextSelected as EventListener);
            // Clean up permission timer on unmount
            if (permissionTimerRef.current) {
                clearInterval(permissionTimerRef.current);
            }
        };
    }, [handleContextSelected, isStopped]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        console.log('[UI] Items updated, count:', items.length, 'types:', items.map(i => i.type));
    }, [items]);

    const handleStreamStart = (message?: any) => {
        const queryText = message?.query || pendingQuery || query;
        console.log('[UI] Stream started for:', queryText);

        // Don't add user message if query is empty or streaming already started
        if (!queryText || queryText.trim().length === 0) {
            console.log('[UI] Skipping empty query in stream start');
            setIsStreaming(true);
            setIsStopped(false);
            setPermissionRequest(null);
            return;
        }

        setIsStreaming(true);
        setIsStopped(false);
        setPermissionRequest(null);

        setItems(prev => {
            // Check if we already have a user message with this content to prevent duplicates
            const lastItem = prev[prev.length - 1];
            if (lastItem && lastItem.type === 'user' && lastItem.content === queryText) {
                console.log('[UI] User message already exists, skipping duplicate');
                return prev;
            }

            // Add user message
            const userItem: ConversationItem = {
                id: `user-${Date.now()}`,
                type: 'user',
                content: queryText,
                timestamp: Date.now()
            };

            console.log('[UI] Adding user message:', queryText);
            return [...prev, userItem];
        });
    };

    const handleThinking = (content: string) => {
        console.log('[UI] Thinking chunk received:', JSON.stringify(content));

        // Skip empty content or just dots
        if (!content || content.trim().length === 0 || content.trim() === '...' || content.trim() === '.') {
            console.log('[UI] Skipping empty/dot thinking chunk');
            return;
        }

        // Skip system thinking messages that aren't actual content
        if (content.includes('Processing your request with enhanced context system') ||
            content.includes('Generating response with enhanced streaming') ||
            content.includes('Starting to process your request') ||
            content.includes('Starting to process') ||
            content.includes('Processing your request')) {
            console.log('[UI] Skipping system thinking message');
            return;
        }

        setItems(prev => {
            const newItems = [...prev];
            const lastItem = newItems[newItems.length - 1];

            // If last item is thinking and streaming, append content
            if (lastItem && lastItem.type === 'thinking' && lastItem.isStreaming) {
                const existingContent = lastItem.content;
                const updatedContent = handleStreamingContent(existingContent, content);
                lastItem.content = updatedContent;
                console.log('[UI] Updated thinking content, was:', existingContent.length, 'chars, now:', updatedContent.length, 'chars');
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
                console.log('[UI] New thinking item created with:', content.substring(0, 50) + '...');
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
        console.log('[UI] Response chunk received:', JSON.stringify(content));

        // Skip empty content
        if (!content || content.trim().length === 0) {
            console.log('[UI] Skipping empty response chunk');
            return;
        }

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
                const existingContent = lastItem.content;
                const updatedContent = handleStreamingContent(existingContent, content);
                lastItem.content = updatedContent;
                console.log('[UI] Updated response content, was:', existingContent.length, 'chars, now:', updatedContent.length, 'chars');
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
                console.log('[UI] New response item created with:', content.substring(0, 50) + '...');
            }

            return newItems;
        });
    };

    const handleStreamComplete = (finalContent?: string) => {
        console.log('[UI] Stream complete, final content:', finalContent?.substring(0, 100) + '...');

        setItems(prev => {
            const newItems = [...prev];

            // Mark all items as complete
            newItems.forEach(item => {
                item.isStreaming = false;
            });

            // Update final response if provided and it's different from current content
            if (finalContent) {
                const lastResponse = newItems.reverse().find(item => item.type === 'response');
                if (lastResponse && lastResponse.content !== finalContent) {
                    // Only update if the final content is significantly different
                    if (finalContent.length > lastResponse.content.length ||
                        !finalContent.includes(lastResponse.content)) {
                        lastResponse.content = finalContent;
                        console.log('[UI] Updated final response with complete content');
                    }
                }
                newItems.reverse();
            }

            return newItems;
        });

        setIsStreaming(false);
        setIsStopped(false);
        setPendingQuery('');
    };

    const handleStreamError = (error: string) => {
        console.log('[UI] Stream error:', error);

        setItems(prev => {
            const newItems = [...prev];

            // Mark all items as complete
            newItems.forEach(item => {
                item.isStreaming = false;
            });

            // Add error item
            const errorItem: ConversationItem = {
                id: `error-${Date.now()}`,
                type: 'response',
                content: `Error: ${error}`,
                metadata: { isError: true },
                timestamp: Date.now()
            };
            newItems.push(errorItem);

            return newItems;
        });

        setIsStreaming(false);
        setIsStopped(false);
        setPendingQuery('');
    };

    const handlePermissionRequest = (message: any) => {
        console.log('[UI] Permission request:', message);
        const timeoutSeconds = message.metadata?.timeout_seconds || 300; // Default 5 minutes
        const permissionRequest: PermissionRequest = {
            id: message.permissionId || message.metadata?.permission_id || '',
            message: message.content || 'Permission required to execute command',
            command: message.terminalCommand || message.metadata?.command || '',
            isBackground: message.metadata?.is_background || false,
            timeoutSeconds: timeoutSeconds,
            startTime: Date.now(),
            friendlyName: message.metadata?.friendly_name || 'terminal command'
        };

        setPermissionRequest(permissionRequest);
        setPermissionTimeLeft(timeoutSeconds);

        // Clear any existing timer
        if (permissionTimerRef.current) {
            clearInterval(permissionTimerRef.current);
        }

        // Start countdown timer
        permissionTimerRef.current = setInterval(() => {
            setPermissionTimeLeft(prev => {
                if (prev <= 1) {
                    if (permissionTimerRef.current) {
                        clearInterval(permissionTimerRef.current);
                        permissionTimerRef.current = null;
                    }

                    // Send denial to backend
                    vscode.postMessage({
                        command: 'permissionResponse',
                        permissionId: permissionRequest?.id || '',
                        granted: false
                    });

                    // Immediately clear the permission popup
                    setPermissionRequest(null);
                    setPermissionTimeLeft(0);

                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    };

    const handlePermissionTimeout = (message: any) => {
        console.log('[UI] Permission timeout:', message);

        // Clear the timer
        if (permissionTimerRef.current) {
            clearInterval(permissionTimerRef.current);
            permissionTimerRef.current = null;
        }

        // Close the permission modal
        setPermissionRequest(null);
        setPermissionTimeLeft(0);
    };

    const handlePermissionResponse = (granted: boolean) => {
        if (!permissionRequest) return;

        console.log('[UI] Permission response:', granted);

        // Clear the timer
        if (permissionTimerRef.current) {
            clearInterval(permissionTimerRef.current);
            permissionTimerRef.current = null;
        }

        vscode.postMessage({
            command: 'permissionResponse',
            permissionId: permissionRequest.id,
            granted: granted
        });

        setPermissionRequest(null);
        setPermissionTimeLeft(0);
    };

    const getCleanToolName = (toolName: string, friendlyName: string): string => {
        // Clean, minimal tool descriptions like Cursor IDE Chat interface
        const cleanNames: Record<string, string> = {
            "grep_search": "Grepping the Codebase",
            "read_file": "Reading File",
            "run_terminal_command": "Running Terminal Command",
            "delete_file": "Deleting File",
            "list_directory": "Listing Directories",
            "search_and_replace": "Searching and Replacing in Files",
            "search_files": "Searching Files",
            "web_search": "Searching the Web",
            "codebase_search": "Searching the Codebase Semantically",
            "edit_file": "Editing File",
            "reapply": "Reapplying Smarter Changes",
            "get_project_structure": "Getting Project Structure",
            "get_git_context": "Fetching Git Context",
        };

        return cleanNames[toolName] || friendlyName || toolName;
    };

    // Input handling is now managed by ContextAwareInput component

    const handleSubmit = () => {
        if (query.trim() && !isStreaming) {
            const trimmedQuery = query.trim();
            console.log('[UI] Submitting query:', trimmedQuery, 'with contexts:', attachedContexts, 'current streaming state:', isStreaming);

            // Store the query before sending
            setPendingQuery(trimmedQuery);

            // Send to extension with original query and attached contexts
            vscode.postMessage({
                command: 'sendQuery',
                text: trimmedQuery,  // Keep original query with @ symbols
                context_mentions: attachedContexts.length > 0 ? attachedContexts : null
            });

            setQuery('');
            // Clear attached contexts after submission
            setAttachedContexts([]);
        } else {
            console.log('[UI] Submit blocked - query:', query.trim(), 'isStreaming:', isStreaming);
        }
    };

    const handleStop = () => {
        console.log('[UI] Stopping conversation - immediate stop requested');

        // Set stopped flag FIRST to prevent processing any more messages
        setIsStopped(true);

        // Send stop command to extension
        vscode.postMessage({
            command: 'stopConversation'
        });

        // Mark all items as complete immediately
        setItems(prev => {
            const newItems = [...prev];
            newItems.forEach(item => {
                if (item.isStreaming) {
                    item.isStreaming = false;
                    // Add a "stopped" indicator for incomplete items
                    if (item.type === 'thinking' || item.type === 'tool' || item.type === 'response') {
                        if (item.type === 'response' && item.content.trim()) {
                            item.content += '\n\n[Stopped by user]';
                        } else if (item.type === 'thinking' && item.content.trim()) {
                            item.content += '\n\n[Stopped by user]';
                        }
                    }
                }
            });
            return newItems;
        });

        // Reset streaming state immediately
        setIsStreaming(false);
        setPendingQuery('');

        // Clear any pending permission requests
        if (permissionTimerRef.current) {
            clearInterval(permissionTimerRef.current);
            permissionTimerRef.current = null;
        }
        setPermissionRequest(null);
        setPermissionTimeLeft(0);

        console.log('[UI] Conversation stopped immediately');
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
                    <div key={item.id} className={`conversation-item thinking-item ${isStreaming ? 'streaming' : ''}`}>
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
                    <div key={item.id} className={`conversation-item response-item ${metadata?.isError ? 'error' : ''} ${isStreaming ? 'streaming' : ''}`}>
                        <div className="item-content response-content">
                            <MarkdownRenderer markdown={content} />
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
                            <div className="welcome-icon">
                                <svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="100pt" height="106pt" viewBox="0 0 300.000000 318.000000" preserveAspectRatio="xMidYMid meet">
                                    <g transform="translate(0.000000,318.000000) scale(0.100000,-0.100000)" fill="#f00a0a" stroke="#ffffff" stroke-width="300">
                                        <path d="M1416 3097 c-14 -10 -51 -165 -162 -668 -79 -359 -160 -706 -180 -769 -88 -279 -231 -530 -425 -747 -35 -40 -170 -172 -299 -293 -152 -143 -244 -238 -261 -268 -30 -53 -46 -167 -23 -158 42 16 1152 198 1255 206 78 6 170 6 248 0 121 -10 221 -25 935 -148 l338 -58 -6 55 c-9 77 -38 131 -99 187 -166 152 -461 441 -525 514 -104 118 -209 281 -286 440 -110 229 -109 226 -347 1310 -46 213 -88 383 -97 393 -18 20 -42 22 -66 4z m96 -223 c22 -99 42 -190 44 -204 3 -14 11 -52 19 -85 8 -33 51 -229 96 -435 123 -570 190 -752 382 -1040 101 -152 169 -225 477 -519 124 -118 235 -230 247 -250 13 -20 23 -52 23 -72 l0 -36 -77 13 c-43 7 -274 46 -513 88 -598 102 -575 99 -760 100 -190 0 -172 3 -845 -113 l-510 -88 -3 33 c-2 18 3 46 12 61 14 28 120 135 326 328 298 280 437 459 567 732 104 218 112 249 339 1282 46 211 89 390 96 398 23 28 39 -13 80 -193z" />
                                    </g>
                                </svg>
                            </div>
                            <div className="welcome-message">
                                I'm Rocket 🚀 Copilot—your AI wingman for code. Drop your toughest tasks, take a break, and I'll handle the heavy lifting. From boilerplate to brain-twisters—consider it done.
                            </div>
                        </div>
                    )}

                    {items.map(renderItem)}

                    <div ref={chatEndRef} />
                </div>
            </div>

            <div className="input-container">
                {/* Show attached contexts */}
                {attachedContexts.length > 0 && (
                    <ContextChips
                        contexts={attachedContexts}
                        onRemove={handleRemoveContext}
                    />
                )}

                <div className="input-wrapper">
                    <ContextAwareInput
                        value={query}
                        onChange={setQuery}
                        onSubmit={handleSubmit}
                        disabled={isStreaming}
                        placeholder="Ask anything..."
                        suggestions={contextSuggestions}
                        attachedContexts={attachedContexts}
                    />

                    <button
                        className="send-button"
                        onClick={isStreaming ? handleStop : handleSubmit}
                        disabled={!isStreaming && !query.trim()}
                    >
                        {isStreaming ? '⏹️' : '➤'}
                    </button>
                </div>
            </div>

            {/* Permission Dialog */}
            {permissionRequest && (
                <div className="permission-modal-overlay">
                    <div className="permission-modal">
                        <div className="permission-header">
                            <h3>⚠️ Permission Required</h3>
                            {permissionTimeLeft > 0 && (
                                <div className="permission-timer">
                                    Auto-deny in: {Math.floor(permissionTimeLeft / 60)}:{String(permissionTimeLeft % 60).padStart(2, '0')}
                                </div>
                            )}
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

export default App;