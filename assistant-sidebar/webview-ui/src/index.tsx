import React from 'react';
import ReactDOM from 'react-dom/client';
import AppStreaming from './AppStreaming';

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
    <AppStreaming />
  </React.StrictMode>
); 