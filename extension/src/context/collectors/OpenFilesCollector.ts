import * as vscode from 'vscode';
import { CollectorMetadata, OpenFilesCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

export class OpenFilesCollector extends BaseCollector {
    private disposables: vscode.Disposable[] = [];

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: any, // Keep parameter for compatibility with BaseCollector
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
                options: {
                    maxFiles: 50,
                    excludeUntitled: false,
                    debug: true // Enable debug logging for testing
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
            this.debug('Starting collection of open files');

            // Get all open text documents
            const openDocuments = vscode.workspace.textDocuments.filter(doc => {
                // Include both file and untitled documents
                if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
                    this.debug(`Excluding document with scheme: ${doc.uri.scheme}`);
                    return false;
                }

                // Optionally exclude untitled documents
                if (this.config.options.excludeUntitled && doc.isUntitled) {
                    this.debug(`Excluding untitled document: ${doc.uri.toString()}`);
                    return false;
                }

                return true;
            });

            this.debug(`Found ${openDocuments.length} open documents after filtering`);

            if (openDocuments.length === 0) {
                this.debug('No open documents found');
                return null;
            }

            // Limit to max files if configured
            const maxFiles = this.config.options.maxFiles || 50;
            const documentsToProcess = openDocuments.slice(0, maxFiles);

            this.debug(`Processing ${documentsToProcess.length} documents (limited by maxFiles: ${maxFiles})`);

            // Gather file information for each document
            const files = await Promise.all(
                documentsToProcess.map(doc => this.gatherFileInfo(doc))
            );

            // Filter out any null results
            const validFiles = files.filter((file): file is NonNullable<typeof file> => file !== null);

            this.debug(`Successfully gathered info for ${validFiles.length} files`);

            // Create the data array as expected by OpenFilesCollectorData type
            const data: OpenFilesCollectorData = validFiles;

            const contextData = this.createContextData(
                this.generateId(),
                data,
                {
                    fileCount: validFiles.length,
                    timestamp: Date.now(),
                    totalOpenDocuments: openDocuments.length
                }
            );

            this.debug(`Context data created successfully with ${validFiles.length} files`);
            return contextData;

        } catch (error) {
            this.error('Failed to collect open files context', error);
            throw error;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Collects context about all open files in the workspace',
            version: '1.1.0',
            dependencies: ['vscode.workspace', 'vscode.window'],
            configurable: true,
            cacheable: false, // Don't cache since open files change frequently
            priority: 8
        };
    }

    /**
     * Gather basic file information from a VSCode TextDocument
     */
    private async gatherFileInfo(document: vscode.TextDocument): Promise<{
        path: string;        
        languageId: string;
        lineCount: number;
        fileSize: number;
        lastModified: string;
    } | null> {
        try {
            const filePath = document.uri.fsPath || document.uri.toString();

            this.debug(`Gathering info for file: ${filePath}`);

            // Get file stats for lastModified (try to get from filesystem first)
            let lastModified: string;
            try {
                if (document.uri.scheme === 'file') {
                    const stats = await vscode.workspace.fs.stat(document.uri);
                    lastModified = new Date(stats.mtime).toISOString();
                } else {
                    // For untitled documents, use current time
                    lastModified = new Date().toISOString();
                }
            } catch {
                // Fallback to current time if we can't get file stats
                lastModified = new Date().toISOString();
            }

            // Calculate file size from document content
            const fileSize = Buffer.byteLength(document.getText(), 'utf8');

            const fileInfo = {
                path: filePath,
                languageId: document.languageId,
                lineCount: document.lineCount,
                fileSize: fileSize,
                lastModified: lastModified
            };

            this.debug(`File info gathered: ${JSON.stringify(fileInfo)}`);
            return fileInfo;

        } catch (error) {
            this.error(`Error gathering file info for ${document.uri.toString()}`, error);
            return null;
        }
    }

    /**
     * Setup event listeners for tracking file changes (optional)
     */
    private setupEventListeners(): void {
        // These are just for logging/debugging purposes since we don't cache
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
                this.debug(`Document opened: ${document.uri.toString()}`);
            })
        );

        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
                this.debug(`Document closed: ${document.uri.toString()}`);
            })
        );
    }

    /**
     * Get simple stats about open files
     */
    getStats(): {
        totalOpenFiles: number;
        languageDistribution: Record<string, number>;
        averageFileSize: number;
        schemeDistribution: Record<string, number>;
    } {
        const openDocs = vscode.workspace.textDocuments;

        const languageDistribution: Record<string, number> = {};
        const schemeDistribution: Record<string, number> = {};
        let totalSize = 0;

        openDocs.forEach(doc => {
            // Count by language
            languageDistribution[doc.languageId] = (languageDistribution[doc.languageId] || 0) + 1;

            // Count by scheme
            schemeDistribution[doc.uri.scheme] = (schemeDistribution[doc.uri.scheme] || 0) + 1;

            // Add to total size
            totalSize += doc.getText().length;
        });

        const averageFileSize = openDocs.length > 0 ? totalSize / openDocs.length : 0;

        return {
            totalOpenFiles: openDocs.length,
            languageDistribution,
            averageFileSize,
            schemeDistribution
        };
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        super.dispose();
    }
} 