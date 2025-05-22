/**
 * Type definition for the VS Code API available in the webview
 */
interface VSCodeAPI {
  /**
   * Post a message to the extension
   */
  postMessage(message: any): void;

  /**
   * Get the persistent state stored for this webview
   */
  getState(): any;

  /**
   * Set the persistent state stored for this webview
   */
  setState(newState: any): void;
}

declare function acquireVsCodeApi(): VSCodeAPI; 