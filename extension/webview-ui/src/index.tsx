import React from 'react';
import ReactDOM from 'react-dom/client';
import AppEnhancedStreaming from './AppEnhancedStreaming';

// Declare vscode for TypeScript
declare global {
  interface Window {
    vscode: any;
  }
}

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <AppEnhancedStreaming />
  </React.StrictMode>
); 