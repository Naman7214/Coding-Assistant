import React, { useState, useEffect, useRef } from 'react';
import MarkdownRenderer from './components/MarkdownRenderer';
import './AppEnhancedStreaming.css';

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

interface StreamingState {
  currentThinking: string;
  currentTools: ToolUsage[];
  currentResponse: string;
  isThinking: boolean;
  isStreaming: boolean;
}

const AppEnhancedStreaming: React.FC = () => {
  const [query, setQuery] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'healthy' | 'unhealthy'>('unknown');
  const [statusMessage, setStatusMessage] = useState('Checking connection...');
  
  // Chat history
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  
  // Current streaming state
  const [streamingState, setStreamingState] = useState<StreamingState>({
    currentThinking: '',
    currentTools: [],
    currentResponse: '',
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

  const handleStreamStart = (message: any) => {
    setStreamingState({
      currentThinking: '',
      currentTools: [],
      currentResponse: '',
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
        isThinking: false,
        isStreaming: false
      };
    });
    
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
      isThinking: false,
      isStreaming: false
    });
    
    setStatusMessage('Error occurred');
  };

  const handleStateCleared = () => {
    setChatHistory([]);
    setStreamingState({
      currentThinking: '',
      currentTools: [],
      currentResponse: '',
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
    
    vscode.postMessage({
      command: 'permissionResponse',
      permissionId: permissionRequest.id,
      granted: granted
    });
    
    setPermissionRequest(null);
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
          <button onClick={clearState} className="toggle-button">
            🗑️ Clear
          </button>
          <button onClick={exportLogs} className="toggle-button">
            📄 Export
          </button>
        </div>
      </div>

      {/* Query input section */}
      <textarea 
        className="streaming-query-input" 
        placeholder="Ask the enhanced agent anything..." 
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={streamingState.isStreaming}
      />
      
      <button 
        className="streaming-send-button" 
        onClick={sendQuery}
        disabled={streamingState.isStreaming || !query.trim()}
      >
        {streamingState.isStreaming ? 'Processing...' : '📤 Send'}
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
              <p><strong>The agent wants to execute:</strong></p>
              <code className="permission-command">
                {permissionRequest.command}
              </code>
              <p className="permission-message">{permissionRequest.message}</p>
              <p style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>
                <strong>Note:</strong> This command will be executed on your system. Please review it carefully.
              </p>
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

export default AppEnhancedStreaming; 