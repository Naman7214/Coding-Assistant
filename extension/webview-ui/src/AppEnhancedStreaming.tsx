import React, { useEffect, useRef, useState } from 'react';
import './AppEnhancedStreaming.css';
import MarkdownRenderer from './components/MarkdownRenderer';
import TerminalDisplay from './components/TerminalDisplay';

// Declare vscode API
declare const vscode: any;

interface ToolUsage {
  name: string;
  arguments?: Record<string, any>;
  result?: string;
  status: 'selecting' | 'executing' | 'completed' | 'error';
  timestamp: number;
}

interface ChatMessage {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
  thinking?: string;
  tools?: ToolUsage[];
  isStreaming?: boolean;
}

interface TerminalState {
  command?: string;
  output: string;
  isExecuting: boolean;
  hasError: boolean;
  processId?: string;
}

interface StreamingState {
  currentThinking: string;
  currentTools: ToolUsage[];
  currentResponse: string;
  currentTerminal: TerminalState;
  isThinking: boolean;
  isStreaming: boolean;
}

interface ContextManagerStatus {
  ready: boolean;
  initializing: boolean;
  error?: string;
}

const AppEnhancedStreaming: React.FC = () => {
  const [query, setQuery] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'healthy' | 'unhealthy'>('unknown');
  const [statusMessage, setStatusMessage] = useState('Checking connection...');

  // Context manager status
  const [contextManagerStatus, setContextManagerStatus] = useState<ContextManagerStatus>({
    ready: false,
    initializing: true,
    error: undefined
  });

  // Chat history
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  // Current streaming state
  const [streamingState, setStreamingState] = useState<StreamingState>({
    currentThinking: '',
    currentTools: [],
    currentResponse: '',
    currentTerminal: {
      output: '',
      isExecuting: false,
      hasError: false
    },
    isThinking: false,
    isStreaming: false
  });

  // Permission state
  const [permissionRequest, setPermissionRequest] = useState<{
    id: string;
    message: string;
    command: string;
  } | null>(null);

  // Stats
  const [eventCount, setEventCount] = useState(0);
  const [lastEventTime, setLastEventTime] = useState<string>('');

  // Refs for auto-scrolling
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Listen for messages from the extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.command) {
        case 'streamStart':
          handleStreamStart(message);
          break;
        case 'thinkingUpdate':
          handleThinkingUpdate(message);
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
          handleResponseUpdate(message);
          break;
        case 'permissionRequest':
          handlePermissionRequest(message);
          break;
        case 'finalResponse':
          handleFinalResponse(message);
          break;
        case 'streamComplete':
          handleStreamComplete(message);
          break;
        case 'streamError':
          handleStreamError(message);
          break;
        case 'stateCleared':
          handleStateCleared();
          break;
        case 'enhancedStreamingHealthStatus':
          handleHealthStatus(message);
          break;
        case 'terminalOutput':
          handleTerminalOutput(message);
          break;
        case 'contextManagerReady':
          handleContextManagerReady(message);
          break;
      }
    };

    window.addEventListener('message', handleMessage);

    // Initial health check
    vscode.postMessage({ command: 'checkStreamingHealth' });

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  // Auto-scroll effect
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, streamingState.currentResponse]);

  const handleContextManagerReady = (message: any) => {
    setContextManagerStatus({
      ready: message.ready,
      initializing: false,
      error: message.error
    });

    if (message.ready) {
      setStatusMessage('Context manager ready');

      // Automatically trigger initial context collection when context manager becomes ready
      // This ensures workspace context is available immediately when the UI loads
      vscode.postMessage({ command: 'collectContext' });
    } else {
      setStatusMessage(`Context manager error: ${message.error}`);
    }
  };

  const handleStreamStart = (message: any) => {
    setStreamingState({
      currentThinking: '',
      currentTools: [],
      currentResponse: '',
      currentTerminal: {
        output: '',
        isExecuting: false,
        hasError: false
      },
      isThinking: false,
      isStreaming: true
    });
    setEventCount(0);
    setPermissionRequest(null);
    setStatusMessage('Streaming...');
  };

  const handleThinkingUpdate = (message: any) => {
    setStreamingState(prev => ({
      ...prev,
      currentThinking: message.fullThinking || prev.currentThinking + (message.content || ''),
      isThinking: message.isThinking
    }));
    updateEventStats();
  };

  const handleToolSelection = (message: any) => {
    const newTool: ToolUsage = {
      name: message.toolName,
      status: 'selecting',
      timestamp: Date.now()
    };

    setStreamingState(prev => ({
      ...prev,
      currentTools: [...prev.currentTools, newTool]
    }));
    updateEventStats();
  };

  const handleToolExecution = (message: any) => {
    setStreamingState(prev => ({
      ...prev,
      currentTools: prev.currentTools.map(tool =>
        tool.name === message.toolName && tool.status === 'selecting'
          ? { ...tool, status: 'executing', arguments: message.arguments }
          : tool
      )
    }));
    updateEventStats();
  };

  const handleToolResult = (message: any) => {
    setStreamingState(prev => ({
      ...prev,
      currentTools: prev.currentTools.map(tool =>
        tool.name === message.toolName && tool.status === 'executing'
          ? {
            ...tool,
            status: message.isError ? 'error' : 'completed',
            result: message.content
          }
          : tool
      )
    }));

    // Clear permission request if this was a terminal command that completed
    if (message.toolName === 'run_terminal_command' && permissionRequest) {
      setTimeout(() => {
        setPermissionRequest(null);
      }, 500); // 0.5 second delay to show completion (reduced from 1 second)
    }

    updateEventStats();
  };

  const handleResponseUpdate = (message: any) => {
    setStreamingState(prev => {
      const newResponse = message.fullResponse || prev.currentResponse + (message.content || '');

      return {
        ...prev,
        currentResponse: newResponse
      };
    });
    updateEventStats();
  };

  const handlePermissionRequest = (message: any) => {
    setPermissionRequest({
      id: message.permissionId,
      message: message.content,
      command: message.commandToExecute
    });

    // Update terminal state with command
    setStreamingState(prev => ({
      ...prev,
      currentTerminal: {
        ...prev.currentTerminal,
        command: message.commandToExecute,
        output: '',
        isExecuting: false,
        hasError: false
      }
    }));
  };

  const handleTerminalOutput = (message: any) => {
    setStreamingState(prev => ({
      ...prev,
      currentTerminal: {
        ...prev.currentTerminal,
        output: message.fullOutput || prev.currentTerminal.output + (message.content || ''),
        isExecuting: !message.isComplete,
        hasError: message.isError || false,
        processId: message.metadata?.process_id || prev.currentTerminal.processId
      }
    }));
    updateEventStats();
  };

  const handleFinalResponse = (message: any) => {
    setStreamingState(prev => ({
      ...prev,
      currentResponse: message.content || prev.currentResponse
    }));
    updateEventStats();
  };

  const handleStreamComplete = (message: any) => {
    // Use functional state update to get the latest streaming state
    setStreamingState(currentState => {
      // Add the completed assistant message to chat history using the current state
      const assistantMessage: ChatMessage = {
        id: Date.now().toString(),
        type: 'assistant',
        content: currentState.currentResponse || 'No response content',
        timestamp: Date.now(),
        thinking: currentState.currentThinking || undefined,
        tools: currentState.currentTools.length > 0 ? currentState.currentTools : undefined,
        isStreaming: false
      };

      setChatHistory(prev => [...prev, assistantMessage]);

      // Return reset state
      return {
        currentThinking: '',
        currentTools: [],
        currentResponse: '',
        currentTerminal: {
          output: '',
          isExecuting: false,
          hasError: false
        },
        isThinking: false,
        isStreaming: false
      };
    });

    // Clear any remaining permission request when stream completes
    setPermissionRequest(null);
    setStatusMessage('Ready');
  };

  const handleStreamError = (message: any) => {
    const errorMessage: ChatMessage = {
      id: Date.now().toString(),
      type: 'assistant',
      content: `❌ Error: ${message.error}`,
      timestamp: Date.now(),
      isStreaming: false
    };

    setChatHistory(prev => [...prev, errorMessage]);

    setStreamingState({
      currentThinking: '',
      currentTools: [],
      currentResponse: '',
      currentTerminal: {
        output: '',
        isExecuting: false,
        hasError: false
      },
      isThinking: false,
      isStreaming: false
    });

    // Clear permission request on error
    setPermissionRequest(null);
    setStatusMessage('Error occurred');
  };

  const handleStateCleared = () => {
    setChatHistory([]);
    setStreamingState({
      currentThinking: '',
      currentTools: [],
      currentResponse: '',
      currentTerminal: {
        output: '',
        isExecuting: false,
        hasError: false
      },
      isThinking: false,
      isStreaming: false
    });
    setEventCount(0);
    setPermissionRequest(null);
  };

  const handleHealthStatus = (message: any) => {
    setConnectionStatus(message.isHealthy ? 'healthy' : 'unhealthy');
    setStatusMessage(message.isHealthy ? 'Enhanced TRUE Streaming Ready' :
      (message.error || 'Enhanced streaming unavailable'));
  };

  const updateEventStats = () => {
    setEventCount(prev => prev + 1);
    setLastEventTime(new Date().toLocaleTimeString());
  };

  const sendQuery = () => {
    if (!query.trim() || streamingState.isStreaming) return;

    // Add user message to chat history
    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      type: 'user',
      content: query.trim(),
      timestamp: Date.now()
    };

    setChatHistory(prev => [...prev, userMessage]);

    vscode.postMessage({
      command: 'sendQuery',
      text: query,
      useStreaming: true
    });

    setQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendQuery();
    }
  };

  const handlePermissionResponse = (granted: boolean) => {
    if (!permissionRequest) return;

    // Update terminal state
    setStreamingState(prev => ({
      ...prev,
      currentTerminal: {
        ...prev.currentTerminal,
        isExecuting: granted,
        output: granted ? 'Executing command...' : 'Permission denied by user',
        hasError: !granted
      }
    }));

    vscode.postMessage({
      command: 'permissionResponse',
      permissionId: permissionRequest.id,
      granted: granted
    });

    // Clear the permission request after a short delay if granted
    // This allows users to see the command being executed briefly
    if (granted) {
      setTimeout(() => {
        setPermissionRequest(null);
      }, 1000); // 1 second delay (reduced from 1.5 seconds)
    } else {
      setPermissionRequest(null);
    }
  };

  const clearState = () => {
    vscode.postMessage({ command: 'clearState' });
  };

  const exportLogs = () => {
    vscode.postMessage({ command: 'exportLogs' });
  };

  const refreshConnection = () => {
    vscode.postMessage({ command: 'checkStreamingHealth' });
  };

  const getStatusIcon = () => {
    switch (connectionStatus) {
      case 'healthy': return '🟢';
      case 'unhealthy': return '🔴';
      default: return '🟡';
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const getToolStatusIcon = (status: string) => {
    switch (status) {
      case 'selecting': return '🔧';
      case 'executing': return '⚙️';
      case 'completed': return '✅';
      case 'error': return '❌';
      default: return '🔧';
    }
  };

  const terminateProcess = (processId: string) => {
    if (!processId) return;

    vscode.postMessage({
      command: 'terminateProcess',
      processId: processId
    });

    // Update UI to show termination in progress
    setStreamingState(prev => ({
      ...prev,
      currentTerminal: {
        ...prev.currentTerminal,
        output: prev.currentTerminal.output + "\n[Terminating process...]\n",
        isExecuting: false,
        hasError: true
      }
    }));
  };

  return (
    <div className="streaming-container">
      {/* Header */}
      <div className="streaming-header">
        <span>🚀 Enhanced Agent Assistant</span>
        <div className="header-controls">
          <button
            className="health-button"
            onClick={refreshConnection}
            title={`Enhanced Streaming: ${connectionStatus}`}
          >
            {getStatusIcon()}
          </button>
          {/* Context Manager Status Indicator */}
          <span
            className={`context-status ${contextManagerStatus.ready ? 'ready' : contextManagerStatus.initializing ? 'initializing' : 'error'}`}
            title={contextManagerStatus.error || (contextManagerStatus.ready ? 'Context manager ready' : 'Context manager initializing...')}
          >
            {contextManagerStatus.ready ? '🟢' : contextManagerStatus.initializing ? '🟡' : '🔴'} Context
          </span>
          <button onClick={clearState} className="toggle-button">
            🗑️ Clear
          </button>
          <button onClick={exportLogs} className="toggle-button">
            📄 Export
          </button>
        </div>
      </div>

      {/* Context Manager Status Message */}
      {!contextManagerStatus.ready && (
        <div className={`context-status-message ${contextManagerStatus.error ? 'error' : 'initializing'}`}>
          {contextManagerStatus.initializing ? (
            <span>🔧 Initializing context manager for workspace analysis...</span>
          ) : contextManagerStatus.error ? (
            <span>❌ Context manager failed to initialize: {contextManagerStatus.error}</span>
          ) : null}
        </div>
      )}

      {/* Query input section */}
      <textarea
        className="streaming-query-input"
        placeholder={
          contextManagerStatus.ready
            ? "Ask the enhanced agent anything..."
            : contextManagerStatus.initializing
              ? "Initializing context manager, please wait..."
              : "Context manager initialization failed"
        }
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={streamingState.isStreaming || !contextManagerStatus.ready}
      />

      <button
        className="streaming-send-button"
        onClick={sendQuery}
        disabled={streamingState.isStreaming || !query.trim() || !contextManagerStatus.ready}
        title={
          !contextManagerStatus.ready
            ? "Context manager must be ready before sending queries"
            : streamingState.isStreaming
              ? "Processing current query..."
              : "Send query to agent"
        }
      >
        {streamingState.isStreaming ? 'Processing...' : !contextManagerStatus.ready ? '⏳ Waiting...' : '📤 Send'}
      </button>

      {/* Chat Thread */}
      <div className="chat-thread">
        {chatHistory.map((message) => (
          <div key={message.id} className={`chat-message ${message.type}`}>
            <div className="message-header">
              <span className="message-type">
                {message.type === 'user' ? '👤 You' : '🤖 Assistant'}
              </span>
              <span className="message-time">{formatTimestamp(message.timestamp)}</span>
            </div>

            <div className="message-content">
              {message.type === 'user' ? (
                <div className="user-message">{message.content}</div>
              ) : (
                <div className="assistant-message">
                  {/* Thinking Section */}
                  {message.thinking && (
                    <details className="thinking-section">
                      <summary>🧠 Agent Thinking ({message.thinking.length} chars)</summary>
                      <div className="thinking-content">
                        <pre>{message.thinking}</pre>
                      </div>
                    </details>
                  )}

                  {/* Tools Section */}
                  {message.tools && message.tools.length > 0 && (
                    <details className="tools-section">
                      <summary>🔧 Tools Used ({message.tools.length})</summary>
                      <div className="tools-content">
                        {message.tools.map((tool, index) => (
                          <div key={index} className="tool-item">
                            <div className="tool-header">
                              <span>{getToolStatusIcon(tool.status)} {tool.name}</span>
                              <span className="tool-status">({tool.status})</span>
                            </div>
                            {tool.arguments && (
                              <details className="tool-arguments">
                                <summary>Arguments</summary>
                                <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
                              </details>
                            )}
                            {tool.result && (
                              <details className="tool-result">
                                <summary>Result</summary>
                                <div className="result-content">
                                  {tool.result.substring(0, 300)}
                                  {tool.result.length > 300 && '...'}
                                </div>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Response Content */}
                  <div className="response-content">
                    <MarkdownRenderer markdown={message.content} />
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Current Streaming Message */}
        {streamingState.isStreaming && (
          <div className="chat-message assistant streaming">
            <div className="message-header">
              <span className="message-type">🤖 Assistant</span>
              <span className="message-time">Streaming...</span>
            </div>

            <div className="message-content">
              <div className="assistant-message">
                {/* Current Thinking */}
                {(streamingState.isThinking || streamingState.currentThinking) && (
                  <details className="thinking-section" open={streamingState.isThinking}>
                    <summary>
                      🧠 Agent Thinking ({streamingState.currentThinking.length} chars)
                      {streamingState.isThinking && <span className="thinking-spinner">💭</span>}
                    </summary>
                    <div className="thinking-content">
                      <pre>{streamingState.currentThinking}</pre>
                    </div>
                  </details>
                )}

                {/* Current Tools */}
                {streamingState.currentTools.length > 0 && (
                  <details className="tools-section" open>
                    <summary>🔧 Tools Being Used ({streamingState.currentTools.length})</summary>
                    <div className="tools-content">
                      {streamingState.currentTools.map((tool, index) => (
                        <div key={index} className="tool-item">
                          <div className="tool-header">
                            <span>{getToolStatusIcon(tool.status)} {tool.name}</span>
                            <span className="tool-status">({tool.status})</span>
                          </div>
                          {tool.arguments && (
                            <details className="tool-arguments">
                              <summary>Arguments</summary>
                              <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
                            </details>
                          )}
                          {tool.result && (
                            <details className="tool-result">
                              <summary>Result</summary>
                              <div className="result-content">
                                {tool.result.substring(0, 300)}
                                {tool.result.length > 300 && '...'}
                              </div>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Current Response */}
                {streamingState.currentResponse && (
                  <div className="response-content">
                    <MarkdownRenderer markdown={streamingState.currentResponse} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Health status footer */}
      <div className="streaming-footer">
        <small>
          Enhanced Streaming: {connectionStatus === 'healthy' ? '🟢 Available' : '🔴 Unavailable'}
          | Events: {eventCount} | Last: {lastEventTime}
        </small>
      </div>

      {/* Permission Dialog Modal */}
      {permissionRequest && (
        <div className="permission-modal-overlay">
          <div className="permission-modal">
            <div className="permission-header">
              <h3>⚠️ Permission Required</h3>
            </div>
            <div className="permission-content">
              <p><strong>The agent wants to execute this command:</strong></p>

              {/* Terminal Display for command */}
              <TerminalDisplay
                command={permissionRequest.command}
                output={streamingState.currentTerminal.output}
                isExecuting={streamingState.currentTerminal.isExecuting}
                isError={streamingState.currentTerminal.hasError}
                height="auto"
                maxHeight="200px"
              />

              <p className="permission-message">{permissionRequest.message}</p>
              <p style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>
                <strong>Note:</strong> This command will be executed on your system. Please review it carefully.
              </p>
            </div>
            <div className="permission-actions">
              {!streamingState.currentTerminal.isExecuting ? (
                <>
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
                </>
              ) : (
                <>
                  <button
                    className="permission-button close-button"
                    onClick={() => setPermissionRequest(null)}
                    title="Close this dialog to see the agent's response while command runs"
                  >
                    Minimize
                  </button>

                  {streamingState.currentTerminal.processId && (
                    <button
                      className="permission-button deny-button"
                      onClick={() => terminateProcess(streamingState.currentTerminal.processId!)}
                    >
                      Terminate Process
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Also show terminal output in the tools section */}
      {streamingState.isStreaming && streamingState.currentTerminal.command && (
        <div className="terminal-section">
          <details open={streamingState.currentTerminal.isExecuting}>
            <summary>
              💻 Terminal Command
              {streamingState.currentTerminal.isExecuting && (
                <>
                  <span className="terminal-spinner">⚙️</span>
                  {streamingState.currentTerminal.processId && (
                    <button
                      className="terminate-button"
                      onClick={() => terminateProcess(streamingState.currentTerminal.processId!)}
                      title="Terminate this process"
                    >
                      ⚠️ Terminate
                    </button>
                  )}
                </>
              )}
            </summary>
            <TerminalDisplay
              command={streamingState.currentTerminal.command}
              output={streamingState.currentTerminal.output}
              isExecuting={streamingState.currentTerminal.isExecuting}
              isError={streamingState.currentTerminal.hasError}
              height="auto"
              maxHeight="250px"
            />
          </details>
        </div>
      )}
    </div>
  );
};

export default AppEnhancedStreaming; 