import React, { useState, useEffect } from 'react';
import MarkdownRenderer from './components/MarkdownRenderer';

interface Message {
  command: string;
  text: string;
}

const App: React.FC = () => {
  const [query, setQuery] = useState<string>('');
  const [response, setResponse] = useState<string>('Response will appear here...');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // Connect to VS Code extension
  const vscode = window.vscode;

  useEffect(() => {
    // Listen for messages from the extension
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const handleMessage = (event: MessageEvent) => {
    const message: Message = event.data;
    
    if (message.command === 'response') {
      setResponse(message.text);
      setIsProcessing(false);
    }
  };

  const handleSubmit = () => {
    if (query.trim()) {
      // Show loading indicator
      setIsProcessing(true);
      setResponse('Processing your query...');
      
      // Send message to extension
      vscode.postMessage({
        command: 'sendQuery',
        text: query
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="container">
      <div className="header">Assistant</div>
      <textarea 
        className="query-input" 
        placeholder="Enter your query here..." 
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button 
        className="send-button" 
        onClick={handleSubmit}
        disabled={isProcessing}
      >
        {isProcessing ? 'Processing...' : 'Send'}
      </button>
      <div className="response-area">
        <MarkdownRenderer markdown={response} />
      </div>
    </div>
  );
};

export default App; 