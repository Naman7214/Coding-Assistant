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
                    includeContent: false, // Don't include full content by default
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
            // Get all open text documents
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

            // Gather file information
            const files = await Promise.all(
                topFiles.map(({ filePath }) => this.gatherFileInfo(filePath))
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

        // Dirty file bonus (unsaved changes)
        if (document.isDirty) {
            score += 3;
            reasons.push('Has unsaved changes');
        }

        // Language relevance bonus
        const languageScore = this.getLanguageRelevanceScore(document.languageId);
        score += languageScore;
        if (languageScore > 0) {
            reasons.push(`${document.languageId} file`);
        }

        // File type bonus
        const typeScore = this.getFileTypeScore(filePath);
        score += typeScore;
        if (typeScore > 0) {
            reasons.push('Important file type');
        }

        // Size penalty for very large files
        const sizeKB = Buffer.byteLength(document.getText(), 'utf8') / 1024;
        if (sizeKB > 1000) {
            score *= 0.8;
            reasons.push('Large file penalty');
        }

        // Tab order bonus (files opened earlier have slight priority)
        const tabOrder = this.getTabOrder(document);
        if (tabOrder >= 0) {
            score += Math.max(0, 3 - tabOrder * 0.1);
            reasons.push('Tab order');
        }

        return {
            filePath,
            score: Math.round(score * 100) / 100,
            reasons
        };
    }

    /**
     * Get relevance score based on programming language
     */
    private getLanguageRelevanceScore(languageId: string): number {
        const sourceLanguages = [
            'typescript', 'javascript', 'python', 'java', 'cpp', 'c', 'csharp',
            'go', 'rust', 'swift', 'kotlin', 'scala', 'ruby', 'php'
        ];

        const configLanguages = [
            'json', 'yaml', 'xml', 'toml', 'ini'
        ];

        const webLanguages = [
            'html', 'css', 'scss', 'less', 'vue', 'svelte', 'jsx', 'tsx'
        ];

        if (sourceLanguages.includes(languageId)) {
            return 3;
        } else if (webLanguages.includes(languageId)) {
            return 2;
        } else if (configLanguages.includes(languageId)) {
            return 1;
        }

        return 0;
    }

    /**
     * Get score based on file type/name
     */
    private getFileTypeScore(filePath: string): number {
        const fileName = path.basename(filePath).toLowerCase();
        const dirName = path.dirname(filePath).toLowerCase();

        // Important config files
        if (['package.json', 'tsconfig.json', 'webpack.config.js', 'vite.config.js',
            'next.config.js', 'tailwind.config.js', '.env', 'dockerfile', 'makefile'].includes(fileName)) {
            return 2;
        }

        // Entry points
        if (['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js'].includes(fileName)) {
            return 2;
        }

        // Test files
        if (fileName.includes('.test.') || fileName.includes('.spec.') || dirName.includes('test')) {
            return 1;
        }

        // README files
        if (fileName.startsWith('readme')) {
            return 1;
        }

        return 0;
    }

    /**
     * Get tab order for a document
     */
    private getTabOrder(document: vscode.TextDocument): number {
        const visibleEditors = vscode.window.visibleTextEditors;
        return visibleEditors.findIndex(editor => editor.document === document);
    }

    /**
     * Gather detailed information about a file
     */
    private async gatherFileInfo(filePath: string): Promise<OpenFilesCollectorData['files'][0] | null> {
        try {
            const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
            if (!document) {
                return null;
            }

            const relativePath = this.getRelativePath(filePath);
            const lastAccess = this.fileAccessTimes.get(filePath) || Date.now();
            const tabOrder = this.getTabOrder(document);
            const isActive = vscode.window.activeTextEditor?.document === document;

            return {
                path: filePath,
                relativePath,
                languageId: document.languageId,
                isDirty: document.isDirty,
                lineCount: document.lineCount,
                fileSize: Buffer.byteLength(document.getText(), 'utf8'),
                lastAccessed: lastAccess,
                tabIndex: tabOrder,
                isActive
            };

        } catch (error) {
            this.debug(`Failed to gather info for file ${filePath}`, error);
            return null;
        }
    }

    /**
     * Setup event listeners for tracking file access patterns
     */
    private setupEventListeners(): void {
        // Track when files are opened/accessed
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor?.document.uri.scheme === 'file') {
                    const filePath = editor.document.uri.fsPath;
                    this.fileAccessTimes.set(filePath, Date.now());
                    this.invalidateCache();
                    this.debug(`File accessed: ${path.basename(filePath)}`);
                }
            })
        );

        // Track document changes (edits)
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.scheme === 'file') {
                    const filePath = event.document.uri.fsPath;
                    const currentCount = this.fileEditCounts.get(filePath) || 0;
                    this.fileEditCounts.set(filePath, currentCount + 1);
                    this.invalidateCache();
                }
            })
        );

        // Track when documents are opened
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(document => {
                if (document.uri.scheme === 'file') {
                    const filePath = document.uri.fsPath;
                    this.fileAccessTimes.set(filePath, Date.now());
                    this.invalidateCache();
                    this.debug(`Document opened: ${path.basename(filePath)}`);
                }
            })
        );

        // Track when documents are closed
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(document => {
                if (document.uri.scheme === 'file') {
                    this.invalidateCache();
                    this.debug(`Document closed: ${path.basename(document.uri.fsPath)}`);
                }
            })
        );

        // Track tab changes
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => {
                this.invalidateCache();
            })
        );
    }

    /**
     * Invalidate cache when open files change
     */
    private invalidateCache(): void {
        const cacheKey = this.generateCacheKey();
        this.cacheManager.delete(`ctx:${this.workspaceId}:${this.type}:${cacheKey}`);
    }

    /**
     * Generate cache key based on open files
     */
    protected generateCacheKey(): string {
        const openFiles = vscode.workspace.textDocuments
            .filter(doc => doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled')
            .map(doc => doc.uri.fsPath)
            .sort();

        const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath || 'none';
        const hash = this.hashString(`${openFiles.join('|')}_${activeFile}`);

        return `open_files_${hash}`;
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
     * Get statistics about open files
     */
    getStats(): {
        totalOpenFiles: number;
        trackedAccessTimes: number;
        trackedEditCounts: number;
        averageFileSize: number;
        languageDistribution: Record<string, number>;
    } {
        const openDocs = vscode.workspace.textDocuments.filter(
            doc => doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled'
        );

        const languageDistribution: Record<string, number> = {};
        let totalSize = 0;

        openDocs.forEach(doc => {
            const lang = doc.languageId;
            languageDistribution[lang] = (languageDistribution[lang] || 0) + 1;
            totalSize += Buffer.byteLength(doc.getText(), 'utf8');
        });

        return {
            totalOpenFiles: openDocs.length,
            trackedAccessTimes: this.fileAccessTimes.size,
            trackedEditCounts: this.fileEditCounts.size,
            averageFileSize: openDocs.length > 0 ? totalSize / openDocs.length : 0,
            languageDistribution
        };
    }

    /**
     * Dispose of collector resources
     */
    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
        this.fileAccessTimes.clear();
        this.fileEditCounts.clear();
        super.dispose();
    }
} 