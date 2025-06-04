import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { ActiveFileCollectorData, CollectorMetadata } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

export class ActiveFileCollector extends BaseCollector {
    private disposables: vscode.Disposable[] = [];
    private lastActiveEditor?: vscode.TextEditor;
    private lastCursorPosition?: vscode.Position;

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string
    ) {
        super(
            'ActiveFileCollector',
            'active_file',
            10.0, // High weight - active file is very important
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 60, // 1 minute cache - active file changes frequently
                options: {
                    includeSurroundingLines: 20,
                    analyzeContext: true,
                    includeSymbols: true,
                    includeDiagnostics: true,
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

            // Gather file information
            const fileInfo = await this.gatherFileInfo(activeEditor, document);

            // Gather cursor and selection context
            const cursorContext = await this.gatherCursorContext(activeEditor, document);

            // Gather viewport context
            const viewportContext = await this.gatherViewportContext(activeEditor, document);

            // Analyze surrounding context
            const semanticContext = await this.gatherSemanticContext(activeEditor, document);

            const data: ActiveFileCollectorData = {
                file: fileInfo,
                cursor: cursorContext,
                viewport: viewportContext,
                context: semanticContext
            };

            const contextData = this.createContextData(
                this.generateId(),
                data,
                {
                    filePath: document.uri.fsPath,
                    languageId: document.languageId,
                    isDirty: document.isDirty,
                    timestamp: Date.now()
                }
            );

            // Track this file access
            await this.trackFileAccess(document);

            return contextData;

        } catch (error) {
            this.error('Failed to collect active file context', error);
            throw error;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Collects detailed context about the currently active file including cursor position, selection, and surrounding code',
            version: '1.0.0',
            dependencies: ['vscode.window', 'vscode.workspace'],
            configurable: true,
            cacheable: true,
            priority: 10
        };
    }

    /**
     * Gather basic file information
     */
    private async gatherFileInfo(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['file']> {
        const workspacePath = this.getWorkspacePath();
        const relativePath = this.getRelativePath(document.uri.fsPath);
        const content = document.getText();

        return {
            path: document.uri.fsPath,
            relativePath,
            content,
            languageId: document.languageId,
            isDirty: document.isDirty,
            lineCount: document.lineCount,
            fileSize: Buffer.byteLength(content, 'utf8')
        };
    }

    /**
     * Gather cursor and selection context
     */
    private async gatherCursorContext(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['cursor']> {
        const selection = editor.selection;
        const position = selection.active;

        return {
            line: position.line,
            character: position.character,
            selection: new vscode.Range(selection.start, selection.end)
        };
    }

    /**
     * Gather viewport context (visible ranges, scroll position)
     */
    private async gatherViewportContext(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['viewport']> {
        const visibleRanges = [...editor.visibleRanges];
        const startLine = visibleRanges.length > 0 ? visibleRanges[0].start.line : 0;
        const endLine = visibleRanges.length > 0 ? visibleRanges[visibleRanges.length - 1].end.line : document.lineCount - 1;

        return {
            visibleRanges,
            startLine,
            endLine
        };
    }

    /**
     * Gather semantic context around cursor
     */
    private async gatherSemanticContext(
        editor: vscode.TextEditor,
        document: vscode.TextDocument
    ): Promise<ActiveFileCollectorData['context']> {
        const position = editor.selection.active;
        const surroundingLinesCount = this.config.options.includeSurroundingLines || 20;

        // Get surrounding lines
        const surroundingLines = this.getSurroundingLines(document, position, surroundingLinesCount);

        // Analyze indentation level
        const indentationLevel = this.getIndentationLevel(document, position);

        // Check if cursor is in function or class
        const codeStructure = await this.analyzeCodeStructure(document, position);

        // Get nearby symbols
        const nearbySymbols = await this.getNearbySymbols(document, position);

        return {
            surroundingLines,
            indentationLevel,
            isInFunction: codeStructure.isInFunction,
            isInClass: codeStructure.isInClass,
            nearbySymbols
        };
    }

    /**
     * Get surrounding lines around cursor position
     */
    private getSurroundingLines(
        document: vscode.TextDocument,
        position: vscode.Position,
        count: number
    ): string[] {
        const startLine = Math.max(0, position.line - Math.floor(count / 2));
        const endLine = Math.min(document.lineCount - 1, position.line + Math.floor(count / 2));

        const lines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            const lineText = document.lineAt(i).text;
            const prefix = i === position.line ? '>>> ' : '    ';
            lines.push(`${prefix}${lineText}`);
        }

        return lines;
    }

    /**
     * Get indentation level at cursor position
     */
    private getIndentationLevel(document: vscode.TextDocument, position: vscode.Position): number {
        const line = document.lineAt(position.line);
        const text = line.text;
        let indentLevel = 0;

        for (let i = 0; i < text.length; i++) {
            if (text[i] === ' ') {
                indentLevel++;
            } else if (text[i] === '\t') {
                indentLevel += 4; // Assuming tab = 4 spaces
            } else {
                break;
            }
        }

        return indentLevel;
    }

    /**
     * Analyze code structure around cursor
     */
    private async analyzeCodeStructure(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<{ isInFunction: boolean; isInClass: boolean }> {
        try {
            // Get document symbols to analyze structure
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (!symbols) {
                return { isInFunction: false, isInClass: false };
            }

            return this.checkPositionInSymbols(symbols, position);
        } catch (error) {
            this.debug('Failed to analyze code structure', error);
            return { isInFunction: false, isInClass: false };
        }
    }

    /**
     * Check if position is within function or class symbols
     */
    private checkPositionInSymbols(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): { isInFunction: boolean; isInClass: boolean } {
        let isInFunction = false;
        let isInClass = false;

        const checkSymbol = (symbol: vscode.DocumentSymbol) => {
            if (symbol.range.contains(position)) {
                if (symbol.kind === vscode.SymbolKind.Function ||
                    symbol.kind === vscode.SymbolKind.Method ||
                    symbol.kind === vscode.SymbolKind.Constructor) {
                    isInFunction = true;
                }

                if (symbol.kind === vscode.SymbolKind.Class ||
                    symbol.kind === vscode.SymbolKind.Interface ||
                    symbol.kind === vscode.SymbolKind.Module) {
                    isInClass = true;
                }

                // Check children recursively
                if (symbol.children) {
                    symbol.children.forEach(checkSymbol);
                }
            }
        };

        symbols.forEach(checkSymbol);
        return { isInFunction, isInClass };
    }

    /**
     * Get symbols near cursor position
     */
    private async getNearbySymbols(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<string[]> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (!symbols) {
                return [];
            }

            const nearbySymbols: string[] = [];
            const searchRange = new vscode.Range(
                new vscode.Position(Math.max(0, position.line - 50), 0),
                new vscode.Position(Math.min(document.lineCount - 1, position.line + 50), 0)
            );

            const collectNearbySymbols = (symbol: vscode.DocumentSymbol) => {
                if (searchRange.intersection(symbol.range)) {
                    nearbySymbols.push(`${vscode.SymbolKind[symbol.kind]}: ${symbol.name}`);
                }

                if (symbol.children) {
                    symbol.children.forEach(collectNearbySymbols);
                }
            };

            symbols.forEach(collectNearbySymbols);
            return nearbySymbols.slice(0, 20); // Limit to 20 nearby symbols

        } catch (error) {
            this.debug('Failed to get nearby symbols', error);
            return [];
        }
    }

    /**
     * Track file access for analytics
     */
    private async trackFileAccess(document: vscode.TextDocument): Promise<void> {
        // This would integrate with SQLiteStorage to track file access patterns
        // For now, just log the access
        this.debug(`Tracking access to file: ${document.uri.fsPath}`);
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
                    this.invalidateCache();
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
                    this.invalidateCache();
                    this.debug('Cursor position changed');
                }
            })
        );

        // Listen for document changes
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && event.document === activeEditor.document) {
                    this.invalidateCache();
                    this.debug('Active document changed');
                }
            })
        );

        // Listen for document saves
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument(document => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && document === activeEditor.document) {
                    this.invalidateCache();
                    this.debug('Active document saved');
                }
            })
        );
    }

    /**
     * Invalidate cache when active file context changes
     */
    private invalidateCache(): void {
        const cacheKey = this.generateCacheKey();
        this.cacheManager.delete(`ctx:${this.workspaceId}:${this.type}:${cacheKey}`);
    }

    /**
     * Generate cache key based on file and cursor position
     */
    protected generateCacheKey(): string {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return 'no_active_file';
        }

        const document = activeEditor.document;
        const position = activeEditor.selection.active;
        const hash = this.hashString(
            `${document.uri.fsPath}_${position.line}_${position.character}_${document.version}`
        );

        return `active_file_${hash}`;
    }

    /**
     * Simple string hashing for cache keys
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
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