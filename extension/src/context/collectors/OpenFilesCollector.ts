import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { CollectorMetadata, OpenFilesCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

interface FileScore {
    filePath: string;
    score: number;
    reasons: string[];
}

export class OpenFilesCollector extends BaseCollector {
    private disposables: vscode.Disposable[] = [];
    private lastOpenFiles: Set<string> = new Set();
    private fileAccessTimes: Map<string, number> = new Map();
    private fileEditCounts: Map<string, number> = new Map();

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string
    ) {
        super(
            'OpenFilesCollector',
            'open_files',
            8.0, // High weight - open files are very relevant
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 300, // 5 minutes cache
                options: {
                    maxFiles: 50,
                    includeContent: false, // Never include content
                    prioritizeByAccess: true,
                    prioritizeByRecency: true,
                    prioritizeByLanguage: true,
                    includeTabOrder: true,
                    excludeUntitled: false,
                    debug: false
                }
            }
        );

        this.setupEventListeners();
    }

    async canCollect(): Promise<boolean> {
        return this.isValidVSCodeState() && vscode.workspace.textDocuments.length > 0;
    }

    async collect(): Promise<ContextData | null> {
        try {
            // Use VSCode API to get all open text documents
            const openDocuments = vscode.workspace.textDocuments.filter(doc => {
                // Filter system documents and output channels
                if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
                    return false;
                }

                // Filter untitled documents if configured
                if (this.config.options.excludeUntitled && doc.isUntitled) {
                    return false;
                }

                return true;
            });

            if (openDocuments.length === 0) {
                return null;
            }

            // Score and prioritize files
            const scoredFiles = await this.scoreAndPrioritizeFiles(openDocuments);

            // Limit to max files
            const maxFiles = this.config.options.maxFiles || 50;
            const topFiles = scoredFiles.slice(0, maxFiles);

            // Gather file information using VSCode API
            const files = await Promise.all(
                topFiles.map(({ filePath }) => this.gatherFileInfoFromVSCode(filePath))
            );

            // Filter out any null results and ensure type safety
            const validFiles = files.filter((file): file is NonNullable<typeof file> => file !== null);

            // Analyze languages and patterns
            const languages = [...new Set(validFiles.map(file => file.languageId))];
            const totalSize = validFiles.reduce((sum, file) => sum + file.fileSize, 0);

            const data: OpenFilesCollectorData = {
                files: validFiles,
                totalCount: validFiles.length,
                languages,
                totalSize
            };

            const contextData = this.createContextData(
                this.generateId(),
                data,
                {
                    fileCount: validFiles.length,
                    totalSize,
                    languages: languages.join(', '),
                    timestamp: Date.now()
                }
            );

            return contextData;

        } catch (error) {
            this.error('Failed to collect open files context', error);
            throw error;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Collects context about all open files with smart prioritization based on access patterns and relevance',
            version: '1.0.0',
            dependencies: ['vscode.workspace', 'vscode.window'],
            configurable: true,
            cacheable: true,
            priority: 8
        };
    }

    /**
     * Score and prioritize files based on various factors
     */
    private async scoreAndPrioritizeFiles(documents: vscode.TextDocument[]): Promise<FileScore[]> {
        const scored: FileScore[] = [];

        for (const document of documents) {
            const filePath = document.uri.fsPath;

            // Skip files not in workspace
            if (!this.shouldIncludeFile(filePath)) {
                continue;
            }

            const score = await this.calculateFileScore(document);
            scored.push(score);
        }

        // Sort by score (highest first)
        return scored.sort((a, b) => b.score - a.score);
    }

    /**
     * Calculate relevance score for a file
     */
    private async calculateFileScore(document: vscode.TextDocument): Promise<FileScore> {
        const filePath = document.uri.fsPath;
        const reasons: string[] = [];
        let score = 0;

        // Base score
        score += 1;

        // Active editor bonus
        if (vscode.window.activeTextEditor?.document === document) {
            score += 10;
            reasons.push('Active file');
        }

        // Visible editor bonus
        const visibleEditors = vscode.window.visibleTextEditors;
        if (visibleEditors.some(editor => editor.document === document)) {
            score += 5;
            reasons.push('Visible in editor');
        }

        // Recent access bonus
        const lastAccess = this.fileAccessTimes.get(filePath);
        if (lastAccess) {
            const timeSinceAccess = Date.now() - lastAccess;
            const hoursAgo = timeSinceAccess / (1000 * 60 * 60);

            if (hoursAgo < 1) {
                score += 8;
                reasons.push('Accessed recently');
            } else if (hoursAgo < 24) {
                score += 4;
                reasons.push('Accessed today');
            }
        }

        // Edit frequency bonus
        const editCount = this.fileEditCounts.get(filePath) || 0;
        if (editCount > 0) {
            score += Math.min(editCount * 0.5, 5);
            reasons.push(`Edited ${editCount} times`);
        }

        // Language relevance bonus
        score += this.getLanguageRelevanceScore(document.languageId);

        // File type importance
        score += this.getFileTypeScore(filePath);

        return { filePath, score, reasons };
    }

    /**
     * Get language relevance score
     */
    private getLanguageRelevanceScore(languageId: string): number {
        const highPriority = ['typescript', 'javascript', 'python', 'java', 'cpp', 'c', 'csharp', 'go', 'rust'];
        const mediumPriority = ['html', 'css', 'scss', 'less', 'json', 'yaml', 'xml'];
        const lowPriority = ['markdown', 'txt', 'log'];

        if (highPriority.includes(languageId)) {
            return 3;
        } else if (mediumPriority.includes(languageId)) {
            return 2;
        } else if (lowPriority.includes(languageId)) {
            return 0.5;
        }
        return 1;
    }

    /**
     * Get file type importance score
     */
    private getFileTypeScore(filePath: string): number {
        const fileName = path.basename(filePath).toLowerCase();

        // Configuration files
        if (['package.json', 'tsconfig.json', 'webpack.config.js', 'vite.config.js'].includes(fileName)) {
            return 4;
        }

        // Main entry files
        if (['index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts'].includes(fileName)) {
            return 3;
        }

        // Test files
        if (fileName.includes('.test.') || fileName.includes('.spec.')) {
            return 2;
        }

        return 1;
    }

    /**
     * Get tab order for a document using VSCode API
     */
    private getTabOrder(document: vscode.TextDocument): number {
        const visibleEditors = vscode.window.visibleTextEditors;
        const tabGroups = vscode.window.tabGroups.all;

        for (let groupIndex = 0; groupIndex < tabGroups.length; groupIndex++) {
            const group = tabGroups[groupIndex];
            for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
                const tab = group.tabs[tabIndex];
                if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString()) {
                    return tabIndex;
                }
            }
        }

        return 999; // Default high number for files not found in tabs
    }

    /**
     * Gather file information using VSCode API only
     */
    private async gatherFileInfoFromVSCode(filePath: string): Promise<OpenFilesCollectorData['files'][0] | null> {
        try {
            // Find the document in VSCode's open documents
            const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
            if (!document) {
                return null;
            }

            const relativePath = this.getRelativePath(filePath);
            const tabOrder = this.getTabOrder(document);
            const isActive = vscode.window.activeTextEditor?.document === document;

            // Get file stats for lastModified
            let lastModified: string;
            try {
                const stats = await vscode.workspace.fs.stat(document.uri);
                lastModified = new Date(stats.mtime).toISOString();
            } catch {
                lastModified = new Date().toISOString();
            }

            return {
                path: filePath,
                relativePath,
                languageId: document.languageId,
                lineCount: document.lineCount,
                fileSize: Buffer.byteLength(document.getText(), 'utf8'),
                lastModified,
                tabIndex: tabOrder,
                isActive
            };

        } catch (error) {
            this.debug(`Error gathering file info for ${filePath}: ${error}`);
            return null;
        }
    }

    private setupEventListeners(): void {
        // Track when documents are opened
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
                if (document.uri.scheme === 'file') {
                    this.fileAccessTimes.set(document.uri.fsPath, Date.now());
                    this.invalidateCache();
                }
            })
        );

        // Track when documents are closed
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
                if (document.uri.scheme === 'file') {
                    this.invalidateCache();
                }
            })
        );

        // Track when documents are edited
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
                if (event.document.uri.scheme === 'file' && event.contentChanges.length > 0) {
                    const filePath = event.document.uri.fsPath;
                    this.fileEditCounts.set(filePath, (this.fileEditCounts.get(filePath) || 0) + 1);
                    this.fileAccessTimes.set(filePath, Date.now());

                    // Debounced cache invalidation
                    setTimeout(() => this.invalidateCache(), 1000);
                }
            })
        );

        // Track when active editor changes
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
                if (editor?.document.uri.scheme === 'file') {
                    this.fileAccessTimes.set(editor.document.uri.fsPath, Date.now());
                    this.invalidateCache();
                }
            })
        );

        // Track when visible editors change
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors((editors: readonly vscode.TextEditor[]) => {
                editors.forEach(editor => {
                    if (editor.document.uri.scheme === 'file') {
                        this.fileAccessTimes.set(editor.document.uri.fsPath, Date.now());
                    }
                });
                this.invalidateCache();
            })
        );
    }

    private invalidateCache(): void {
        this.cacheManager.delete(this.generateCacheKey());
    }

    protected generateCacheKey(): string {
        const openFileHashes = vscode.workspace.textDocuments
            .filter(doc => doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled')
            .map(doc => this.hashString(doc.uri.toString()))
            .sort()
            .join('|');

        return `${this.type}:${this.workspaceId}:${this.hashString(openFileHashes)}`;
    }

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    getStats(): {
        totalOpenFiles: number;
        trackedAccessTimes: number;
        trackedEditCounts: number;
        averageFileSize: number;
        languageDistribution: Record<string, number>;
    } {
        const openDocs = vscode.workspace.textDocuments.filter(doc =>
            doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled'
        );

        const totalSize = openDocs.reduce((sum, doc) => sum + doc.getText().length, 0);
        const averageFileSize = openDocs.length > 0 ? totalSize / openDocs.length : 0;

        const languageDistribution: Record<string, number> = {};
        openDocs.forEach(doc => {
            languageDistribution[doc.languageId] = (languageDistribution[doc.languageId] || 0) + 1;
        });

        return {
            totalOpenFiles: openDocs.length,
            trackedAccessTimes: this.fileAccessTimes.size,
            trackedEditCounts: this.fileEditCounts.size,
            averageFileSize,
            languageDistribution
        };
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
} 