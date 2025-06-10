import * as vscode from 'vscode';
import { ActiveFileCollectorData, CollectorMetadata } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

export class ActiveFileCollector extends BaseCollector {
    private disposables: vscode.Disposable[] = [];
    private lastActiveEditor?: vscode.TextEditor;
    private lastCursorPosition?: vscode.Position;

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: any, // Keep parameter but don't use it
        workspaceId: string
    ) {
        super(
            'ActiveFileCollector',
            'active_file',
            10.0, // High weight - active file is very important
            outputChannel,
            cacheManager, // Pass through to base class
            workspaceId,
            {
                cacheTimeout: 0, // Disable caching by setting timeout to 0
                options: {
                    includeSurroundingLines: 20,
                    analyzeContext: false,
                    includeSymbols: false,
                    includeDiagnostics: false,
                    debug: false
                }
            }
        );

        this.setupEventListeners();
    }

    async canCollect(): Promise<boolean> {
        return this.isValidVSCodeState() && !!vscode.window.activeTextEditor;
    }

    async collect(): Promise<ContextData | null> {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return null;
        }

        try {
            const document = activeEditor.document;
            const workspacePath = this.getWorkspacePath();

            // Skip if file is not in workspace or should be excluded
            if (!document.uri.fsPath.startsWith(workspacePath)) {
                this.debug('Active file is outside workspace');
                return null;
            }

            if (!this.shouldIncludeFile(document.uri.fsPath)) {
                this.debug('Active file excluded by patterns');
                return null;
            }

            // Gather simplified file information
            const fileInfo = await this.gatherSimpleFileInfo(activeEditor, document);

            // Gather simplified cursor context
            const cursorContext = await this.gatherSimpleCursorContext(activeEditor, document);

            // Gather simplified viewport context
            const viewportContext = await this.gatherSimpleViewportContext(activeEditor, document);

            const data: ActiveFileCollectorData = {
                file: fileInfo,
                cursor: cursorContext,
                viewport: viewportContext
            };

            const contextData = this.createContextData(
                this.generateId(),
                data,
                {
                    filePath: document.uri.fsPath,
                    languageId: document.languageId,
                    timestamp: Date.now()
                }
            );

            return contextData;

        } catch (error) {
            this.error('Failed to collect active file context', error);
            throw error;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Collects context about the currently active file including cursor position, selection, and surrounding code',
            version: '1.0.0',
            dependencies: ['vscode.window', 'vscode.workspace'],
            configurable: true,
            cacheable: false, // Explicitly mark as not cacheable
            priority: 10
        };
    }

    /**
     * Gather simplified file information
     */
    private async gatherSimpleFileInfo(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['file']> {
        // Get file stats for lastModified
        let lastModified: string;
        try {
            const stats = await vscode.workspace.fs.stat(document.uri);
            lastModified = new Date(stats.mtime).toISOString();
        } catch {
            lastModified = new Date().toISOString();
        }

        return {
            path: document.uri.fsPath,
            languageId: document.languageId,
            lineCount: document.lineCount,
            fileSize: Buffer.byteLength(document.getText(), 'utf8'),
            lastModified
        };
    }

    /**
     * Gather simplified cursor context
     */
    private async gatherSimpleCursorContext(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['cursor']> {
        const selection = editor.selection;
        const position = selection.active;

        // Get current line content
        const currentLine = document.lineAt(position.line);
        const currentLineContent = currentLine.text;

        // Get line above (if exists)
        let lineAboveContent: string | undefined;
        if (position.line > 0) {
            const lineAbove = document.lineAt(position.line - 1);
            lineAboveContent = lineAbove.text;
        }

        // Get line below (if exists)
        let lineBelowContent: string | undefined;
        if (position.line < document.lineCount - 1) {
            const lineBelow = document.lineAt(position.line + 1);
            lineBelowContent = lineBelow.text;
        }

        return {
            line: position.line + 1, // VSCode uses 0-indexed, display uses 1-indexed
            character: position.character + 1, // VSCode uses 0-indexed, display uses 1-indexed
            selection: [
                {
                    line: selection.start.line,
                    character: selection.start.character
                },
                {
                    line: selection.end.line,
                    character: selection.end.character
                }
            ],
            lineContent: {
                current: currentLineContent,
                above: lineAboveContent,
                below: lineBelowContent
            }
        };
    }

    /**
     * Gather simplified viewport context
     */
    private async gatherSimpleViewportContext(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['viewport']> {
        const visibleRanges = [...editor.visibleRanges];
        const startLine = visibleRanges.length > 0 ? visibleRanges[0].start.line : 0;
        const endLine = visibleRanges.length > 0 ? visibleRanges[visibleRanges.length - 1].end.line : document.lineCount - 1;

        // Convert VSCode ranges to simple array format
        const simpleRanges = visibleRanges.map(range => [
            {
                line: range.start.line,
                character: range.start.character
            },
            {
                line: range.end.line,
                character: range.end.character
            }
        ]);

        return {
            visibleRanges: simpleRanges,
            startLine,
            endLine
        };
    }

    /**
     * Set up event listeners for real-time updates
     */
    private setupEventListeners(): void {
        // Listen for active editor changes
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor && editor !== this.lastActiveEditor) {
                    this.lastActiveEditor = editor;
                    this.debug('Active editor changed');
                }
            })
        );

        // Listen for cursor position changes
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(event => {
                const newPosition = event.textEditor.selection.active;
                if (!this.lastCursorPosition ||
                    !newPosition.isEqual(this.lastCursorPosition)) {
                    this.lastCursorPosition = newPosition;
                    this.debug('Cursor position changed');
                }
            })
        );

        // Listen for document changes
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && event.document === activeEditor.document) {
                    this.debug('Active document changed');
                }
            })
        );

        // Listen for document saves
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(document => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && document === activeEditor.document) {
                    this.debug('Active document saved');
                }
            })
        );
    }

    /**
     * Override shouldUseCache to always return false
     */
    protected shouldUseCache(): boolean {
        return false;
    }

    /**
     * Dispose of collector resources
     */
    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
        super.dispose();
    }
} 