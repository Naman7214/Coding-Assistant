import { createRoot } from 'react-dom/client';
import App from './App';

// Declare vscode for TypeScript
declare global {
  interface Window {
    vscode: any;
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

const root = createRoot(container);
root.render(<App />); 