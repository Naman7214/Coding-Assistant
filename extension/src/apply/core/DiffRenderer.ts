import * as vscode from 'vscode';
import {
    AppliedChange,
    DecorationState,
    DiffLine,
    DiffResult,
    IDiffRenderer
} from '../types/apply.types';

export class DiffRenderer implements IDiffRenderer {
    private decorationTypes: {
        added: vscode.TextEditorDecorationType;
        removed: vscode.TextEditorDecorationType;
        modified: vscode.TextEditorDecorationType;
        streaming: vscode.TextEditorDecorationType;
    };

    private activeDecorations: Map<string, DecorationState> = new Map();

    // **NEW: File-specific button management**
    private fileControls: Map<string, {
        acceptButton: vscode.StatusBarItem;
        rejectButton: vscode.StatusBarItem;
        acceptCommand: vscode.Disposable;
        rejectCommand: vscode.Disposable;
    }> = new Map();

    constructor() {
        this.decorationTypes = this.createDecorationTypes();
    }

    /**
     * **SIMPLIFIED: Basic diff calculation using VSCode-native line comparison**
     */
    calculateDiff(original: string, modified: string): DiffResult {
        return this.calculateSimpleDiff(original, modified);
    }

    /**
     * **NEW: Simplified diff calculation**
     */
    calculateSimpleDiff(original: string, modified: string): DiffResult {
        const originalLines = original.split('\n');
        const modifiedLines = modified.split('\n');

        const additions: DiffLine[] = [];
        const deletions: DiffLine[] = [];
        const modifications: DiffLine[] = [];
        const unchanged: DiffLine[] = [];

        const maxLines = Math.max(originalLines.length, modifiedLines.length);

        for (let i = 0; i < maxLines; i++) {
            const originalLine = originalLines[i];
            const modifiedLine = modifiedLines[i];

            if (originalLine === undefined) {
                // Line was added
                additions.push({
                    lineNumber: i + 1,
                    content: modifiedLine,
                    type: 'added'
                });
            } else if (modifiedLine === undefined) {
                // Line was removed
                deletions.push({
                    lineNumber: i + 1,
                    content: originalLine,
                    type: 'removed'
                });
            } else if (originalLine !== modifiedLine) {
                // Line was modified
                modifications.push({
                    lineNumber: i + 1,
                    content: modifiedLine,
                    type: 'modified'
                });
            } else {
                // Line unchanged
                unchanged.push({
                    lineNumber: i + 1,
                    content: originalLine,
                    type: 'unchanged'
                });
            }
        }

        return { additions, deletions, modifications, unchanged };
    }

    /**
     * **SIMPLIFIED: Basic diff rendering**
     */
    renderDiff(editor: vscode.TextEditor, diff: DiffResult): void {
        this.renderSimpleDiff(editor, diff);
    }

    /**
     * **NEW: Simplified diff rendering using VSCode decorations**
     */
    renderSimpleDiff(editor: vscode.TextEditor, diff: DiffResult): void {
        const filePath = editor.document.uri.fsPath;

        // Clear existing decorations
        this.clearDiff(editor);

        const decorationState: DecorationState = {
            addedLines: [],
            removedLines: [],
            modifiedLines: [],
            streamingLines: [],
        };

        // Process additions (green)
        diff.additions.forEach(line => {
            if (line.lineNumber <= editor.document.lineCount) {
                const range = new vscode.Range(line.lineNumber - 1, 0, line.lineNumber - 1, line.content.length);
                decorationState.addedLines.push({
                    range,
                    hoverMessage: `Added: ${line.content}`
                });
            }
        });

        // Process deletions (red) - show as empty line decoration
        diff.deletions.forEach(line => {
            if (line.lineNumber <= editor.document.lineCount) {
                const range = new vscode.Range(line.lineNumber - 1, 0, line.lineNumber - 1, 0);
                decorationState.removedLines.push({
                    range,
                    hoverMessage: `Removed: ${line.content}`,
                    renderOptions: {
                        after: {
                            contentText: ` ⛔ Removed: ${line.content}`,
                            color: 'rgba(255, 100, 100, 0.8)'
                        }
                    }
                });
            }
        });

        // Process modifications (blue)
        diff.modifications.forEach(line => {
            if (line.lineNumber <= editor.document.lineCount) {
                const range = new vscode.Range(line.lineNumber - 1, 0, line.lineNumber - 1, line.content.length);
                decorationState.modifiedLines.push({
                    range,
                    hoverMessage: `Modified: ${line.content}`
                });
            }
        });

        // Apply decorations
        editor.setDecorations(this.decorationTypes.added, decorationState.addedLines);
        editor.setDecorations(this.decorationTypes.removed, decorationState.removedLines);
        editor.setDecorations(this.decorationTypes.modified, decorationState.modifiedLines);

        // Store decoration state
        this.activeDecorations.set(filePath, decorationState);
    }

    /**
     * **NEW: Add file-specific accept/reject controls**
     */
    addFileControls(
        editor: vscode.TextEditor,
        filePath: string,
        onDecision: (accepted: boolean) => Promise<void>
    ): void {
        // Remove existing controls for this file if any
        this.clearFileControls(editor, filePath);

        const fileName = require('path').basename(filePath);
        const commandId = Date.now().toString();

        // Create accept button
        const acceptButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
        acceptButton.text = `$(check) Accept ${fileName}`;
        acceptButton.tooltip = `Accept changes for ${fileName}`;
        acceptButton.command = `apply.accept.${commandId}`;
        acceptButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');

        // Create reject button
        const rejectButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 199);
        rejectButton.text = `$(close) Reject ${fileName}`;
        rejectButton.tooltip = `Reject changes for ${fileName}`;
        rejectButton.command = `apply.reject.${commandId}`;
        rejectButton.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

        // Register commands
        const acceptCommand = vscode.commands.registerCommand(`apply.accept.${commandId}`, async () => {
            await onDecision(true);
        });

        const rejectCommand = vscode.commands.registerCommand(`apply.reject.${commandId}`, async () => {
            await onDecision(false);
        });

        // Show buttons
        acceptButton.show();
        rejectButton.show();

        // Store controls for cleanup
        this.fileControls.set(filePath, {
            acceptButton,
            rejectButton,
            acceptCommand,
            rejectCommand
        });

        // Show info message
        vscode.window.showInformationMessage(
            `Changes applied to ${fileName}. Use the status bar buttons to accept or reject.`,
            { modal: false }
        );
    }

    /**
     * **NEW: Clear file-specific controls**
     */
    clearFileControls(editor: vscode.TextEditor, filePath: string): void {
        // Clear decorations
        this.clearDiff(editor);

        // Clear and dispose file-specific controls
        const controls = this.fileControls.get(filePath);
        if (controls) {
            controls.acceptButton.dispose();
            controls.rejectButton.dispose();
            controls.acceptCommand.dispose();
            controls.rejectCommand.dispose();
            this.fileControls.delete(filePath);
        }
    }

    /**
     * Clear all diff decorations from the editor
     */
    clearDiff(editor: vscode.TextEditor): void {
        const filePath = editor.document.uri.fsPath;

        // Clear all decoration types
        editor.setDecorations(this.decorationTypes.added, []);
        editor.setDecorations(this.decorationTypes.removed, []);
        editor.setDecorations(this.decorationTypes.modified, []);
        editor.setDecorations(this.decorationTypes.streaming, []);

        // Remove from active decorations
        this.activeDecorations.delete(filePath);
    }

    /**
     * Animate changes being applied (streaming effect)
     */
    async animateChanges(editor: vscode.TextEditor, changes: AppliedChange[]): Promise<void> {
        for (const change of changes) {
            if (change.lineNumber <= editor.document.lineCount) {
                const range = new vscode.Range(
                    change.lineNumber - 1, 0,
                    change.lineNumber - 1, change.content.length
                );

                const streamingDecoration: vscode.DecorationOptions = {
                    range,
                    hoverMessage: `Applying: ${change.type} - ${change.content}`,
                };

                editor.setDecorations(this.decorationTypes.streaming, [streamingDecoration]);
                await this.delay(100);
                editor.setDecorations(this.decorationTypes.streaming, []);
            }
        }
    }

    /**
     * Highlight specific lines during streaming
     */
    highlightStreamingLines(editor: vscode.TextEditor, lineNumbers: number[]): void {
        const streamingDecorations: vscode.DecorationOptions[] = lineNumbers
            .filter(lineNumber => lineNumber <= editor.document.lineCount)
            .map(lineNumber => ({
                range: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, editor.document.lineAt(lineNumber - 1).text.length),
                hoverMessage: 'Content being streamed...',
            }));

        editor.setDecorations(this.decorationTypes.streaming, streamingDecorations);
    }

    /**
     * Clear streaming decorations
     */
    clearStreamingDecorations(editor: vscode.TextEditor): void {
        editor.setDecorations(this.decorationTypes.streaming, []);
    }

    /**
     * Get diff summary statistics
     */
    getDiffSummary(diff: DiffResult): {
        additions: number;
        deletions: number;
        modifications: number;
        total: number;
    } {
        return {
            additions: diff.additions.length,
            deletions: diff.deletions.length,
            modifications: diff.modifications.length,
            total: diff.additions.length + diff.deletions.length + diff.modifications.length,
        };
    }

    /**
     * Create decoration types for different change types
     */
    private createDecorationTypes() {
        return {
            added: vscode.window.createTextEditorDecorationType({
                backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
                border: '3px solid',
                borderColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
                isWholeLine: true,
                overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),

            removed: vscode.window.createTextEditorDecorationType({
                backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
                border: '3px solid',
                borderColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
                isWholeLine: true,
                overviewRulerColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
                textDecoration: 'line-through',
            }),

            modified: vscode.window.createTextEditorDecorationType({
                backgroundColor: new vscode.ThemeColor('diffEditor.modifiedTextBackground'),
                border: '3px solid',
                borderColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
                isWholeLine: true,
                overviewRulerColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),

            streaming: vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255, 255, 0, 0.1)',
                border: '3px solid yellow',
                isWholeLine: true,
                overviewRulerColor: 'yellow',
                overviewRulerLane: vscode.OverviewRulerLane.Right,
            }),
        };
    }

    /**
     * Utility method for delays
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Dispose all decoration types and file controls
     */
    dispose(): void {
        Object.values(this.decorationTypes).forEach(decoration => decoration.dispose());
        this.activeDecorations.clear();

        // Dispose all file controls
        for (const controls of this.fileControls.values()) {
            controls.acceptButton.dispose();
            controls.rejectButton.dispose();
            controls.acceptCommand.dispose();
            controls.rejectCommand.dispose();
        }
        this.fileControls.clear();
    }

    /**
     * Get active decorations for a file
     */
    getActiveDecorations(filePath: string): DecorationState | undefined {
        return this.activeDecorations.get(filePath);
    }

    /**
     * Check if file has active decorations
     */
    hasActiveDecorations(filePath: string): boolean {
        return this.activeDecorations.has(filePath);
    }

    /**
     * **NEW: Show VSCode's native diff view for comparing original content with modified content**
     */
    showVSCodeDiff(
        originalContent: string,
        modifiedContent: string,
        filePath: string
    ): void {
        // Create file name for the diff view
        const fileName = require('path').basename(filePath);

        // Create temporary URIs in memory
        const originalUri = vscode.Uri.parse(`untitled:${fileName}.original`).with({
            scheme: 'untitled',
            path: `${fileName}.original`
        });

        const modifiedUri = vscode.Uri.file(filePath);

        // Start with opening the editor for original file
        vscode.workspace.openTextDocument(originalUri).then(originalDoc => {
            // Insert content to original document
            const edit = new vscode.WorkspaceEdit();
            edit.insert(
                originalUri,
                new vscode.Position(0, 0),
                originalContent
            );

            // Apply the edit with original content
            vscode.workspace.applyEdit(edit).then(success => {
                if (success) {
                    // Now open the diff view with original and modified content
                    vscode.commands.executeCommand(
                        'vscode.diff',
                        originalUri,
                        modifiedUri,
                        `${fileName} (Before ↔ After)`,
                        { viewColumn: vscode.ViewColumn.Beside }
                    );
                }
            });
        });
    }
} 