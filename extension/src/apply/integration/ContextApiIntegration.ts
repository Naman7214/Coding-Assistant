import { applyApiHandler, ApplyApiRequest, ApplyApiResponse } from '../api/ApplyApiHandler';

/**
 * Integration helper for connecting Apply feature with ContextApiServer
 * 
 * This file shows how to integrate the apply feature with your existing ContextApiServer.
 * Add these routes to your ContextApiServer.ts file.
 */

/**
 * Add these routes to your ContextApiServer class:
 * 
 * Example integration in ContextApiServer.ts:
 * 
 * ```typescript
 * import { applyApiHandler } from './apply/api/ApplyApiHandler';
 * 
 * // In your route setup:
 * 
 * // POST /api/apply - Main apply endpoint for MCP server
 * this.app.post('/api/apply', async (req, res) => {
 *   try {
 *     const result = await applyApiHandler.handleApplyRequest(req.body);
 *     res.json(result);
 *   } catch (error) {
 *     res.status(500).json({
 *       success: false,
 *       message: error.message,
 *       linterErrors: []
 *     });
 *   }
 * });
 * 
 * // GET /api/apply/status - Get current apply status
 * this.app.get('/api/apply/status', (req, res) => {
 *   const status = applyApiHandler.getApplyStatus();
 *   res.json(status);
 * });
 * 
 * // POST /api/apply/cancel - Cancel current operation
 * this.app.post('/api/apply/cancel', (req, res) => {
 *   applyApiHandler.cancelApplyOperation();
 *   res.json({ success: true, message: 'Operation cancelled' });
 * });
 * 
 * // GET /api/apply/test-connection - Test FastAPI connection
 * this.app.get('/api/apply/test-connection', async (req, res) => {
 *   const isConnected = await applyApiHandler.testConnection();
 *   res.json({ connected: isConnected });
 * });
 * 
 * // GET /api/apply/config - Get apply configuration
 * this.app.get('/api/apply/config', (req, res) => {
 *   const config = applyApiHandler.getApplyConfig();
 *   res.json(config);
 * });
 * 
 * // PUT /api/apply/config - Update apply configuration
 * this.app.put('/api/apply/config', (req, res) => {
 *   applyApiHandler.updateApplyConfig(req.body);
 *   res.json({ success: true, message: 'Configuration updated' });
 * });
 * 
 * // POST /api/apply/clear-decorations - Clear all decorations
 * this.app.post('/api/apply/clear-decorations', (req, res) => {
 *   applyApiHandler.clearDecorations();
 *   res.json({ success: true, message: 'Decorations cleared' });
 * });
 * 
 * // GET /api/apply/statistics - Get apply statistics
 * this.app.get('/api/apply/statistics', (req, res) => {
 *   const stats = applyApiHandler.getApplyStatistics();
 *   res.json(stats);
 * });
 * ```
 */

/**
 * Helper functions for manual testing and integration
 */
export class ContextApiIntegration {

    /**
     * Test the apply feature with sample data
     */
    static async testApplyFeature(filePath: string, codeSnippet: string): Promise<ApplyApiResponse> {
        const request: ApplyApiRequest = {
            filePath,
            codeSnippet,
            explanation: 'Test apply operation'
        };

        return await applyApiHandler.handleApplyRequest(request);
    }

    /**
     * Get the apply API handler instance
     */
    static getApplyHandler() {
        return applyApiHandler;
    }

    /**
     * Setup VSCode commands for the apply feature
     */
    static setupVSCodeCommands() {
        return [
            // Command to manually trigger apply on current file
            {
                command: 'coding-agent.applyToCurrentFile',
                title: 'Apply Code to Current File',
                callback: async () => {
                    const editor = require('vscode').window.activeTextEditor;
                    if (!editor) {
                        require('vscode').window.showErrorMessage('No active editor');
                        return;
                    }

                    const codeSnippet = await require('vscode').window.showInputBox({
                        prompt: 'Enter code snippet to apply',
                        placeHolder: 'console.log("Hello World");'
                    });

                    if (codeSnippet) {
                        const result = await this.testApplyFeature(editor.document.uri.fsPath, codeSnippet);
                        require('vscode').window.showInformationMessage(
                            result.success ? 'Apply completed successfully' : `Apply failed: ${result.message}`
                        );
                    }
                }
            },

            // Command to show apply status
            {
                command: 'coding-agent.showApplyStatus',
                title: 'Show Apply Status',
                callback: () => {
                    const status = applyApiHandler.getApplyStatus();
                    require('vscode').window.showInformationMessage(
                        `Apply Status - In Progress: ${status.inProgress}, Has Backup: ${status.hasBackup}`
                    );
                }
            },

            // Command to cancel apply operation
            {
                command: 'coding-agent.cancelApply',
                title: 'Cancel Apply Operation',
                callback: () => {
                    applyApiHandler.cancelApplyOperation();
                    require('vscode').window.showInformationMessage('Apply operation cancelled');
                }
            },

            // Command to test FastAPI connection
            {
                command: 'coding-agent.testFastAPIConnection',
                title: 'Test FastAPI Connection',
                callback: async () => {
                    const isConnected = await applyApiHandler.testConnection();
                    require('vscode').window.showInformationMessage(
                        isConnected ? 'FastAPI connection successful' : 'FastAPI connection failed'
                    );
                }
            },

            // Command to clear decorations
            {
                command: 'coding-agent.clearApplyDecorations',
                title: 'Clear Apply Decorations',
                callback: () => {
                    applyApiHandler.clearDecorations();
                    require('vscode').window.showInformationMessage('Apply decorations cleared');
                }
            },

            // Command to show apply output
            {
                command: 'coding-agent.showApplyOutput',
                title: 'Show Apply Output',
                callback: () => {
                    applyApiHandler.showOutputChannel();
                }
            }
        ];
    }
}

/**
 * Example request format for MCP server:
 * 
 * ```json
 * {
 *   "filePath": "/path/to/your/file.js",
 *   "codeSnippet": "console.log('Hello from Apply!');",
 *   "explanation": "Adding a debug log statement"
 * }
 * ```
 * 
 * Example response format:
 * 
 * ```json
 * {
 *   "success": true,
 *   "message": "Code applied successfully",
 *   "linterErrors": [
 *     {
 *       "file": "/path/to/your/file.js",
 *       "line": 10,
 *       "column": 5,
 *       "severity": "warning",
 *       "message": "Unexpected console statement",
 *       "source": "eslint",
 *       "code": "no-console"
 *     }
 *   ]
 * }
 * ```
 */

export default ContextApiIntegration; 