import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Get the webview content for the extension
 * @param webview The webview to get content for
 * @param extensionUri The URI of the extension
 */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  // Get path to the webview build directory
  const webviewPath = path.join(extensionUri.fsPath, 'webview-ui', 'build');
  
  // Check if the build directory exists
  if (!fs.existsSync(webviewPath)) {
    return getErrorHtml('Webview UI not built. Please run: npm run build-webview');
  }
  
  // Check for main.js and main.css
  const jsPath = path.join(webviewPath, 'static', 'js', 'main.js');
  const cssPath = path.join(webviewPath, 'static', 'css', 'main.css');
  
  if (!fs.existsSync(jsPath)) {
    return getErrorHtml('Webview JS file not found. Please run: npm run build-webview');
  }

  // Convert to webview URIs
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(jsPath));
  const styleMainUri = webview.asWebviewUri(vscode.Uri.file(cssPath));

  // Use a nonce to allow only specific scripts to run
  const nonce = getNonce();

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <title>Assistant</title>
    <link href="${styleMainUri}" rel="stylesheet">
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      window.vscode = vscode;
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
  </html>`;
}

/**
 * Generate an error HTML message
 * @param message The error message to display
 */
function getErrorHtml(message: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error</title>
    <style>
      body {
        padding: 20px;
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
      }
      .error {
        color: var(--vscode-errorForeground);
        padding: 10px;
        border: 1px solid var(--vscode-errorForeground);
        border-radius: 5px;
        margin-top: 20px;
      }
      .instruction {
        margin-top: 20px;
      }
    </style>
  </head>
  <body>
    <h1>Assistant Webview Error</h1>
    <div class="error">${message}</div>
    <div class="instruction">
      Please follow the build instructions in the README.md file.
    </div>
  </body>
  </html>`;
}

/**
 * Generate a nonce string
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
} 