import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { CollectorMetadata } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

export interface ProblemInfo {
    filePath: string;
    relativePath: string;
    message: string;
    severity: vscode.DiagnosticSeverity;
    source?: string;
    code?: string | number | { value: string | number; target: vscode.Uri };
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
    position: {
        line: number;
        character: number;
    };
    relatedInformation?: Array<{
        location: {
            uri: string;
            range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
            };
        };
        message: string;
    }>;
}

export interface ProblemsCollectorData {
    problems: ProblemInfo[];
    summary: {
        totalProblems: number;
        errorCount: number;
        warningCount: number;
        infoCount: number;
        hintCount: number;
        filesWithProblems: number;
        problemsByFile: Record<string, number>;
        problemsBySeverity: Record<string, number>;
        problemsBySource: Record<string, number>;
    };
    timestamp: number;
    workspacePath: string;
    requestedFilePath?: string;
}

export class ProblemsCollector extends BaseCollector {
    private disposables: vscode.Disposable[] = [];
    private requestedFilePath?: string;

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string
    ) {
        super(
            'ProblemsCollector',
            'problems',
            8.0, // High weight - problems are important for context
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 120, // 2 minutes cache - problems change moderately
                options: {
                    includeAllSeverities: true,
                    includeRelatedInformation: true,
                    maxProblemsPerFile: 50,
                    excludeNodeModules: true,
                    includeOnlyWorkspaceFiles: true,
                    debug: true
                }
            }
        );

        this.setupEventListeners();
    }

    async canCollect(): Promise<boolean> {
        const isValid = this.isValidVSCodeState();
        const hasWorkspace = !!vscode.workspace.workspaceFolders;

        this.debug(`canCollect() - isValidVSCodeState: ${isValid}, hasWorkspace: ${hasWorkspace}`);

        if (!isValid) {
            this.debug('VSCode state is not valid');
        }

        if (!hasWorkspace) {
            this.debug('No workspace folders available');
        }

        return isValid && hasWorkspace;
    }

    /**
     * Set a specific file path to collect problems for
     */
    setTargetFilePath(filePath?: string): void {
        this.requestedFilePath = filePath;
        this.invalidateCache(); // Clear cache when target changes
    }

    async collect(): Promise<ContextData | null> {
        try {
            this.debug('ProblemsCollector.collect() starting...');

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.debug('No workspace folder available in collect()');
                return null;
            }

            this.debug(`Workspace folder: ${workspaceFolder.uri.fsPath}`);
            const workspacePath = workspaceFolder.uri.fsPath;
            let problems: ProblemInfo[] = [];

            if (this.requestedFilePath) {
                // Collect problems for specific file
                this.debug(`Collecting problems for specific file: ${this.requestedFilePath}`);
                problems = await this.collectFileProblems(this.requestedFilePath);
                this.debug(`Collected ${problems.length} problems for file: ${this.requestedFilePath}`);
            } else {
                // Collect problems for entire workspace
                this.debug('Collecting problems for entire workspace');
                problems = await this.collectWorkspaceProblems();
                this.debug(`Collected ${problems.length} problems for workspace`);
            }

            // Generate summary statistics
            const summary = this.generateSummary(problems);

            const data: ProblemsCollectorData = {
                problems,
                summary,
                timestamp: Date.now(),
                workspacePath,
                requestedFilePath: this.requestedFilePath
            };

            const contextData = this.createContextData(
                this.generateId(),
                data,
                {
                    fileCount: summary.filesWithProblems,
                    problemCount: summary.totalProblems,
                    targetFile: this.requestedFilePath,
                    timestamp: Date.now()
                }
            );

            return contextData;

        } catch (error) {
            this.error('Failed to collect problems context', error);
            throw error;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Collects VSCode problems/diagnostics from the workspace or specific files, including error positions and source information',
            version: '1.0.0',
            dependencies: ['vscode.languages', 'vscode.workspace'],
            configurable: true,
            cacheable: true,
            priority: 8
        };
    }

    /**
     * Collect problems for a specific file
     */
    private async collectFileProblems(filePath: string): Promise<ProblemInfo[]> {
        const problems: ProblemInfo[] = [];

        try {
            const fileUri = vscode.Uri.file(filePath);
            const diagnostics = vscode.languages.getDiagnostics(fileUri);

            for (const diagnostic of diagnostics) {
                const problemInfo = this.convertDiagnosticToProblemInfo(fileUri, diagnostic);
                if (problemInfo && this.shouldIncludeProblem(problemInfo)) {
                    problems.push(problemInfo);
                }
            }

        } catch (error) {
            this.warn(`Failed to collect problems for file ${filePath}: ${error}`);
        }

        return problems;
    }

    /**
     * Collect problems for entire workspace
     */
    private async collectWorkspaceProblems(): Promise<ProblemInfo[]> {
        const problems: ProblemInfo[] = [];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            this.debug('No workspace folder in collectWorkspaceProblems');
            return problems;
        }

        try {
            // Get all diagnostics from the language service
            this.debug('Getting all diagnostics from vscode.languages.getDiagnostics()');
            const allDiagnostics = vscode.languages.getDiagnostics();
            this.debug(`Found ${allDiagnostics.length} diagnostic entries`);

            // Log first few diagnostics for debugging
            if (allDiagnostics.length > 0) {
                this.debug(`First diagnostic entry: URI=${allDiagnostics[0][0].toString()}, Diagnostics count=${allDiagnostics[0][1].length}`);
                if (allDiagnostics[0][1].length > 0) {
                    const firstDiag = allDiagnostics[0][1][0];
                    this.debug(`First diagnostic: ${firstDiag.message} (severity: ${firstDiag.severity})`);
                }
            } else {
                this.debug('No diagnostics found - this might indicate a timing issue or no problems in workspace');
            }

            for (const [uri, diagnostics] of allDiagnostics) {
                // Skip if not in workspace
                if (!this.isFileInWorkspace(uri, workspaceFolder)) {
                    continue;
                }

                // Skip if file should be excluded
                if (!this.shouldIncludeFile(uri.fsPath)) {
                    continue;
                }

                // Limit problems per file
                const maxProblemsPerFile = this.config.options.maxProblemsPerFile || 50;
                const limitedDiagnostics = diagnostics.slice(0, maxProblemsPerFile);

                for (const diagnostic of limitedDiagnostics) {
                    const problemInfo = this.convertDiagnosticToProblemInfo(uri, diagnostic);
                    if (problemInfo && this.shouldIncludeProblem(problemInfo)) {
                        problems.push(problemInfo);
                    }
                }
            }

        } catch (error) {
            this.error('Failed to collect workspace problems', error);
        }

        return problems;
    }

    /**
     * Convert VSCode Diagnostic to ProblemInfo
     */
    private convertDiagnosticToProblemInfo(uri: vscode.Uri, diagnostic: vscode.Diagnostic): ProblemInfo | null {
        try {
            const workspacePath = this.getWorkspacePath();
            const relativePath = this.getRelativePath(uri.fsPath);

            const problemInfo: ProblemInfo = {
                filePath: uri.fsPath,
                relativePath,
                message: diagnostic.message,
                severity: diagnostic.severity,
                source: diagnostic.source,
                code: diagnostic.code,
                range: {
                    start: {
                        line: diagnostic.range.start.line + 1, // Convert to 1-indexed
                        character: diagnostic.range.start.character + 1
                    },
                    end: {
                        line: diagnostic.range.end.line + 1,
                        character: diagnostic.range.end.character + 1
                    }
                },
                position: {
                    line: diagnostic.range.start.line + 1, // Use start position as main position
                    character: diagnostic.range.start.character + 1
                }
            };

            // Add related information if available
            if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
                problemInfo.relatedInformation = diagnostic.relatedInformation.map(related => ({
                    location: {
                        uri: related.location.uri.toString(),
                        range: {
                            start: {
                                line: related.location.range.start.line + 1,
                                character: related.location.range.start.character + 1
                            },
                            end: {
                                line: related.location.range.end.line + 1,
                                character: related.location.range.end.character + 1
                            }
                        }
                    },
                    message: related.message
                }));
            }

            return problemInfo;

        } catch (error) {
            this.warn(`Failed to convert diagnostic to problem info: ${error}`);
            return null;
        }
    }

    /**
     * Check if file is in workspace
     */
    private isFileInWorkspace(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): boolean {
        return uri.fsPath.startsWith(workspaceFolder.uri.fsPath);
    }

    /**
     * Check if problem should be included based on configuration
     */
    private shouldIncludeProblem(problem: ProblemInfo): boolean {
        // Always include if includeAllSeverities is true
        if (this.config.options.includeAllSeverities) {
            return true;
        }

        // Include errors and warnings by default
        return problem.severity === vscode.DiagnosticSeverity.Error ||
            problem.severity === vscode.DiagnosticSeverity.Warning;
    }

    /**
     * Generate summary statistics for problems
     */
    private generateSummary(problems: ProblemInfo[]): ProblemsCollectorData['summary'] {
        const summary = {
            totalProblems: problems.length,
            errorCount: 0,
            warningCount: 0,
            infoCount: 0,
            hintCount: 0,
            filesWithProblems: 0,
            problemsByFile: {} as Record<string, number>,
            problemsBySeverity: {} as Record<string, number>,
            problemsBySource: {} as Record<string, number>
        };

        const fileSet = new Set<string>();

        for (const problem of problems) {
            // Count by severity
            switch (problem.severity) {
                case vscode.DiagnosticSeverity.Error:
                    summary.errorCount++;
                    break;
                case vscode.DiagnosticSeverity.Warning:
                    summary.warningCount++;
                    break;
                case vscode.DiagnosticSeverity.Information:
                    summary.infoCount++;
                    break;
                case vscode.DiagnosticSeverity.Hint:
                    summary.hintCount++;
                    break;
            }

            // Count by file
            fileSet.add(problem.filePath);
            summary.problemsByFile[problem.relativePath] = (summary.problemsByFile[problem.relativePath] || 0) + 1;

            // Count by severity string
            const severityName = this.getSeverityName(problem.severity);
            summary.problemsBySeverity[severityName] = (summary.problemsBySeverity[severityName] || 0) + 1;

            // Count by source
            if (problem.source) {
                summary.problemsBySource[problem.source] = (summary.problemsBySource[problem.source] || 0) + 1;
            }
        }

        summary.filesWithProblems = fileSet.size;

        return summary;
    }

    /**
     * Get severity name for grouping
     */
    private getSeverityName(severity: vscode.DiagnosticSeverity): string {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return 'error';
            case vscode.DiagnosticSeverity.Warning:
                return 'warning';
            case vscode.DiagnosticSeverity.Information:
                return 'info';
            case vscode.DiagnosticSeverity.Hint:
                return 'hint';
            default:
                return 'unknown';
        }
    }

    /**
     * Setup event listeners for diagnostic changes
     */
    private setupEventListeners(): void {
        // Listen for diagnostic changes
        this.disposables.push(
            vscode.languages.onDidChangeDiagnostics((event) => {
                if (this.config.options.debug) {
                    this.debug(`Diagnostics changed for ${event.uris.length} files`);
                }
                this.invalidateCache();
            })
        );

        // Listen for workspace changes
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(() => {
                this.invalidateCache();
            })
        );

        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(() => {
                this.invalidateCache();
            })
        );
    }

    /**
     * Invalidate cache when problems change
     */
    private invalidateCache(): void {
        const cacheKey = this.generateCacheKey();
        const fullCacheKey = `ctx:${this.workspaceId}:${this.type}:${cacheKey}`;
        this.cacheManager.delete(fullCacheKey);
    }

    /**
     * Generate cache key including requested file path
     */
    protected generateCacheKey(): string {
        const baseKey = `${this.name}_${this.type}`;
        if (this.requestedFilePath) {
            return `${baseKey}_${this.hashString(this.requestedFilePath)}`;
        }
        return baseKey;
    }

    /**
     * Simple hash function for cache keys
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
        super.dispose();
    }
} 