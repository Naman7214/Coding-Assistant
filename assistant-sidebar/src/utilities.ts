import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * System information interface
 */
export interface SystemInfo {
  platform: string;
  osVersion: string;
  architecture: string;
  workspacePath: string;
  defaultShell: string;
  nodeVersion: string;
  vsCodeVersion: string;
  extensionVersion: string;
  environmentVariables: Record<string, string>;
  workspaceName?: string;
  workspaceFolders: string[];
}

/**
 * Get comprehensive system information from VS Code context
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const workspacePath = workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
  const workspaceName = workspaceFolders.length > 0 ? workspaceFolders[0].name : undefined;

  // Get default shell from VS Code configuration
  const config = vscode.workspace.getConfiguration();
  let defaultShell = '';

  // Try to get shell from VS Code settings
  const platform = os.platform();
  if (platform === 'win32') {
    defaultShell = config.get('terminal.integrated.shell.windows') ||
      config.get('terminal.integrated.defaultProfile.windows') ||
      process.env.COMSPEC || 'cmd.exe';
  } else if (platform === 'darwin') {
    defaultShell = config.get('terminal.integrated.shell.osx') ||
      config.get('terminal.integrated.defaultProfile.osx') ||
      process.env.SHELL || '/bin/zsh';
  } else {
    defaultShell = config.get('terminal.integrated.shell.linux') ||
      config.get('terminal.integrated.defaultProfile.linux') ||
      process.env.SHELL || '/bin/bash';
  }

  // Get relevant environment variables
  const relevantEnvVars: Record<string, string> = {};
  const envKeysToInclude = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'NODE_ENV'];

  envKeysToInclude.forEach(key => {
    if (process.env[key]) {
      relevantEnvVars[key] = process.env[key]!;
    }
  });

  return {
    platform: os.platform(),
    osVersion: os.release(),
    architecture: os.arch(),
    workspacePath,
    workspaceName,
    workspaceFolders: workspaceFolders.map(folder => folder.uri.fsPath),
    defaultShell,
    nodeVersion: process.version,
    vsCodeVersion: vscode.version,
    extensionVersion: vscode.extensions.getExtension('your-extension-id')?.packageJSON?.version || 'unknown',
    environmentVariables: relevantEnvVars
  };
}

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