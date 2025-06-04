import React, { useState, useEffect, useRef } from 'react';
import './TerminalDisplay.css';

interface TerminalProps {
  command?: string;
  output?: string;
  isExecuting: boolean;
  isError?: boolean;
  height?: string;
  maxHeight?: string;
  className?: string;
}

const TerminalDisplay: React.FC<TerminalProps> = ({
  command,
  output,
  isExecuting,
  isError = false,
  height = 'auto',
  maxHeight = '300px',
  className = ''
}) => {
  const [cursorVisible, setCursorVisible] = useState(true);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Blink cursor effect
  useEffect(() => {
    if (!isExecuting) return;
    
    const blinkInterval = setInterval(() => {
      setCursorVisible(prev => !prev);
    }, 500);
    
    return () => clearInterval(blinkInterval);
  }, [isExecuting]);
  
  // Auto-scroll effect
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div 
      className={`terminal-display ${className} ${isError ? 'error' : ''}`}
      style={{ height, maxHeight }}
      ref={terminalRef}
    >
      <div className="terminal-header">
        <div className="terminal-controls">
          <span className="terminal-button red"></span>
          <span className="terminal-button yellow"></span>
          <span className="terminal-button green"></span>
        </div>
        <div className="terminal-title">Terminal</div>
      </div>
      
      <div className="terminal-content">
        {command && (
          <div className="terminal-command-line">
            <span className="terminal-prompt">$</span>
            <span className="terminal-command">{command}</span>
            {isExecuting && cursorVisible && <span className="terminal-cursor">▋</span>}
          </div>
        )}
        
        {output && (
          <div className="terminal-output">
            {output.split('\n').map((line, i) => (
              <div key={i} className="terminal-line">{line || ' '}</div>
            ))}
          </div>
        )}
        
        {isExecuting && !command && (
          <div className="terminal-loader">
            <span className="loader-dot">.</span>
            <span className="loader-dot">.</span>
            <span className="loader-dot">.</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default TerminalDisplay; 