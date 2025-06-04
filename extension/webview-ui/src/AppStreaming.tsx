import React, { useState, useEffect, useRef } from 'react';
import MarkdownRenderer from './components/MarkdownRenderer';
import './AppStreaming.css';

interface Message {
  command: string;
  text?: string;
  type?: string;
  content?: string;
  metadata?: any;
  query?: string;
  error?: string;
  isHealthy?: boolean;
  url?: string;
}

interface StreamEvent {
  type: string;
  content: string;
  metadata?: any;
  timestamp: number;
}

const App: React.FC = () => {
  const [query, setQuery] = useState<string>('');
  const [response, setResponse] = useState<string>('Response will appear here...');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [streamingEnabled, setStreamingEnabled] = useState<boolean>(true);
  const [streamingHealthy, setStreamingHealthy] = useState<boolean>(false);
  const [streamingUrl, setStreamingUrl] = useState<string>('');
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [currentThinking, setCurrentThinking] = useState<string>('');
  const [currentTool, setCurrentTool] = useState<string>('');
  const [permissionRequest, setPermissionRequest] = useState<{
    message: string;
    command: string;
    permissionId: string;
  } | null>(null);
  const responseEndRef = useRef<HTMLDivElement>(null);

  // Connect to VS Code extension
  const vscode = window.vscode;

  useEffect(() => {
    // Listen for messages from the extension
    window.addEventListener('message', handleMessage);
    
    // Check streaming health on startup
    vscode.postMessage({ command: 'checkStreamingHealth' });
    
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom when response updates
    responseEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [response, streamEvents]);

  const handleMessage = (event: MessageEvent) => {
    const message: Message = event.data;
    
    switch (message.command) {
      case 'response':
        // Original API response
        setResponse(message.text || '');
        setIsProcessing(false);
        break;
        
      case 'streamStart':
        // Streaming started
        setIsProcessing(true);
        setResponse('');
        setStreamEvents([]);
        setCurrentThinking('');
        setCurrentTool('');
        break;
        
      case 'streamEvent':
        handleStreamEvent(message);
        break;
        
      case 'streamComplete':
        // Streaming completed
        setIsProcessing(false);
        setCurrentThinking('');
        setCurrentTool('');
        if (message.content) {
          setResponse(message.content);
        }
        break;
        
      case 'streamError':
        // Streaming error
        setIsProcessing(false);
        setCurrentThinking('');
        setCurrentTool('');
        setResponse(`Error: ${message.error}`);
        break;
        
      case 'streamingHealthStatus':
        setStreamingHealthy(message.isHealthy || false);
        setStreamingUrl(message.url || '');
        break;
        
      case 'permissionRequest':
        // Handle permission request from backend
        setPermissionRequest({
          message: message.content || '',
          command: message.metadata?.command || '',
          permissionId: message.metadata?.permission_id || ''
        });
        break;
    }
  };

  const handleStreamEvent = (message: Message) => {
    const event: StreamEvent = {
      type: message.type || 'unknown',
      content: message.content || '',
      metadata: message.metadata,
      timestamp: Date.now()
    };

    setStreamEvents(prev => [...prev, event]);

    switch (event.type) {
      case 'thinking':
        setCurrentThinking(event.content);
        break;
        
      case 'tool_selection':
        setCurrentTool(event.metadata?.tool_name || 'Unknown tool');
        break;
        
      case 'tool_execution':
        setCurrentTool(`Executing: ${event.metadata?.tool_name || 'Unknown tool'}`);
        break;
        
      case 'assistant_response':
        // Append to response for real-time display
        setResponse(prev => prev + event.content);
        break;
        
      case 'tool_result':
        if (event.metadata?.error) {
          setCurrentTool(`❌ ${event.metadata?.tool_name} failed`);
        } else {
          setCurrentTool(`✅ ${event.metadata?.tool_name} completed`);
        }
        break;
    }
  };

  const handleSubmit = () => {
    if (query.trim()) {
      setIsProcessing(true);
      setResponse('');
      setStreamEvents([]);
      
      // Send message to extension
      vscode.postMessage({
        command: 'sendQuery',
        text: query,
        useStreaming: streamingEnabled
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const toggleStreaming = () => {
    setStreamingEnabled(!streamingEnabled);
  };

  const refreshHealth = () => {
    vscode.postMessage({ command: 'checkStreamingHealth' });
  };

  const handlePermissionResponse = (granted: boolean) => {
    if (permissionRequest) {
      // Send response back to extension (which will forward to backend)
      vscode.postMessage({
        command: 'permissionResponse',
        permissionId: permissionRequest.permissionId,
        granted: granted
      });
      
      // Clear the permission request
      setPermissionRequest(null);
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <div className="streaming-container">
      <div className="streaming-header">
        <span>Assistant</span>
        <div className="header-controls">
          <button 
            className={`toggle-button ${streamingEnabled ? 'enabled' : 'disabled'}`}
            onClick={toggleStreaming}
            title={`Streaming is ${streamingEnabled ? 'enabled' : 'disabled'}`}
          >
            {streamingEnabled ? '🔄' : '📝'} {streamingEnabled ? 'Streaming' : 'Original'}
          </button>
          <button 
            className="health-button"
            onClick={refreshHealth}
            title={`Streaming API: ${streamingHealthy ? 'Healthy' : 'Unavailable'}`}
          >
            {streamingHealthy ? '🟢' : '🔴'}
          </button>
        </div>
      </div>

      {/* Status indicators */}
      {isProcessing && (
        <div className="status-bar">
          {currentThinking && (
            <div className="thinking-indicator">
              🤔 {currentThinking}
            </div>
          )}
          {currentTool && (
            <div className="tool-indicator">
              🔧 {currentTool}
            </div>
          )}
        </div>
      )}

      {/* Query input section */}
      <textarea 
        className="streaming-query-input" 
        placeholder="Enter your query here..." 
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isProcessing}
      />
      
      <button 
        className="streaming-send-button" 
        onClick={handleSubmit}
        disabled={isProcessing || !query.trim()}
      >
        {isProcessing ? 'Processing...' : 'Send'}
      </button>

      {/* Stream events panel (collapsible) - Now in the middle */}
      {streamingEnabled && streamEvents.length > 0 && (
        <details className="stream-events">
          <summary>Stream Events ({streamEvents.length})</summary>
          <div className="events-list">
            {streamEvents.map((event, index) => (
              <div key={index} className={`event event-${event.type}`}>
                <div className="event-header">
                  <span className="event-type">{event.type}</span>
                  <span className="event-time">{formatTimestamp(event.timestamp)}</span>
                </div>
                <div className="event-content">
                  {event.content}
                  {event.metadata && (
                    <details className="event-metadata">
                      <summary>Metadata</summary>
                      <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Main response area - Now at the bottom */}
      <div className="streaming-response-area">
        <MarkdownRenderer markdown={response} />
        <div ref={responseEndRef} />
      </div>

      {/* Health status */}
      <div className="streaming-footer">
        <small>
          Streaming API: {streamingHealthy ? '🟢 Available' : '🔴 Unavailable'} 
          {streamingUrl && ` (${streamingUrl})`}
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
              <code className="permission-command" title="Scroll to see full command if truncated">
                {permissionRequest.command}
              </code>
              {permissionRequest.command.length > 200 && (
                <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
                  ↕️ Scroll above to see the full command
                </p>
              )}
              <p className="permission-message">{permissionRequest.message}</p>
              <p style={{ fontSize: '13px', color: 'var(--vscode-descriptionForeground)' }}>
                <strong>Note:</strong> This command will be executed on your system. Please review it carefully before allowing.
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

export default App; 