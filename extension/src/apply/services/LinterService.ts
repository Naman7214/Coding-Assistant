import * as vscode from 'vscode';
import { ILinterService, LinterError, LinterResult } from '../types/apply.types';

export class LinterService implements ILinterService {
    private watchers: Map<string, vscode.Disposable> = new Map();

    /**
     * Collect all linter errors for a specific file
     */
    async collectErrors(uri: vscode.Uri): Promise<LinterError[]> {
        try {
            // Get diagnostics from all sources
            const diagnostics = vscode.languages.getDiagnostics(uri);

            // Format and return
            return this.formatErrors(diagnostics);

        } catch (error) {
            console.error('Failed to collect linter errors:', error);
            return [];
        }
    }

    /**
     * Watch for linter error changes on a file
     */
    watchForErrors(uri: vscode.Uri, callback: (errors: LinterError[]) => void): vscode.Disposable {
        const key = uri.toString();

        // Clean up existing watcher if any
        const existingWatcher = this.watchers.get(key);
        if (existingWatcher) {
            existingWatcher.dispose();
        }

        // Create new watcher
        const watcher = vscode.languages.onDidChangeDiagnostics(event => {
            // Check if the change affects our file
            const affectedUri = event.uris.find(eventUri => eventUri.toString() === uri.toString());

            if (affectedUri) {
                // Collect and send updated errors
                this.collectErrors(uri).then(errors => {
                    callback(errors);
                }).catch(error => {
                    console.error('Failed to collect errors in watcher:', error);
                    callback([]);
                });
            }
        });

        // Store watcher for cleanup
        this.watchers.set(key, watcher);

        // Send initial errors
        this.collectErrors(uri).then(callback).catch(error => {
            console.error('Failed to collect initial errors:', error);
            callback([]);
        });

        return watcher;
    }

    /**
     * Format VSCode diagnostics into our LinterError format
     */
    formatErrors(diagnostics: vscode.Diagnostic[]): LinterError[] {
        return diagnostics.map(diagnostic => ({
            file: '', // Will be set by caller
            line: diagnostic.range.start.line + 1, // Convert to 1-based
            column: diagnostic.range.start.character + 1, // Convert to 1-based
            severity: this.mapSeverity(diagnostic.severity),
            message: diagnostic.message,
            source: diagnostic.source || 'unknown',
            code: diagnostic.code ? diagnostic.code.toString() : undefined,
        }));
    }

    /**
     * Get comprehensive linter results with categorization
     */
    async getLinterResults(uri: vscode.Uri): Promise<LinterResult> {
        const allErrors = await this.collectErrors(uri);

        const errors = allErrors.filter(error => error.severity === 'error');
        const warnings = allErrors.filter(error => error.severity === 'warning');

        return {
            errors,
            warnings,
            totalCount: allErrors.length,
        };
    }

    /**
     * Get errors for multiple files
     */
    async collectErrorsForFiles(uris: vscode.Uri[]): Promise<Map<string, LinterError[]>> {
        const results = new Map<string, LinterError[]>();

        const promises = uris.map(async uri => {
            try {
                const errors = await this.collectErrors(uri);
                // Set the file path in errors
                const errorsWithFile = errors.map(error => ({
                    ...error,
                    file: uri.fsPath,
                }));
                results.set(uri.fsPath, errorsWithFile);
            } catch (error) {
                console.error(`Failed to collect errors for ${uri.fsPath}:`, error);
                results.set(uri.fsPath, []);
            }
        });

        await Promise.all(promises);
        return results;
    }

    /**
     * Check if a file has any errors
     */
    async hasErrors(uri: vscode.Uri): Promise<boolean> {
        const errors = await this.collectErrors(uri);
        return errors.some(error => error.severity === 'error');
    }

    /**
     * Check if a file has any warnings
     */
    async hasWarnings(uri: vscode.Uri): Promise<boolean> {
        const errors = await this.collectErrors(uri);
        return errors.some(error => error.severity === 'warning');
    }

    /**
     * Get errors in a specific line range
     */
    async getErrorsInRange(uri: vscode.Uri, startLine: number, endLine: number): Promise<LinterError[]> {
        const allErrors = await this.collectErrors(uri);

        return allErrors.filter(error =>
            error.line >= startLine && error.line <= endLine
        );
    }

    /**
     * Filter errors by severity
     */
    filterBySeverity(errors: LinterError[], severity: 'error' | 'warning' | 'info'): LinterError[] {
        return errors.filter(error => error.severity === severity);
    }

    /**
     * Filter errors by source (linter)
     */
    filterBySource(errors: LinterError[], source: string): LinterError[] {
        return errors.filter(error => error.source === source);
    }

    /**
     * Group errors by severity
     */
    groupBySeverity(errors: LinterError[]): Record<string, LinterError[]> {
        return errors.reduce((groups, error) => {
            const severity = error.severity;
            if (!groups[severity]) {
                groups[severity] = [];
            }
            groups[severity].push(error);
            return groups;
        }, {} as Record<string, LinterError[]>);
    }

    /**
     * Group errors by source (linter)
     */
    groupBySource(errors: LinterError[]): Record<string, LinterError[]> {
        return errors.reduce((groups, error) => {
            const source = error.source;
            if (!groups[source]) {
                groups[source] = [];
            }
            groups[source].push(error);
            return groups;
        }, {} as Record<string, LinterError[]>);
    }

    /**
     * Get unique sources (linters) from errors
     */
    getUniqueSources(errors: LinterError[]): string[] {
        const sources = new Set(errors.map(error => error.source));
        return Array.from(sources);
    }

    /**
     * Format errors for display
     */
    formatErrorsForDisplay(errors: LinterError[]): string {
        if (errors.length === 0) {
            return 'No linter errors found.';
        }

        const grouped = this.groupBySeverity(errors);
        const parts: string[] = [];

        if (grouped.error?.length > 0) {
            parts.push(`❌ Errors (${grouped.error.length}):`);
            grouped.error.forEach(error => {
                parts.push(`  Line ${error.line}: ${error.message} (${error.source})`);
            });
        }

        if (grouped.warning?.length > 0) {
            parts.push(`⚠️  Warnings (${grouped.warning.length}):`);
            grouped.warning.forEach(error => {
                parts.push(`  Line ${error.line}: ${error.message} (${error.source})`);
            });
        }

        if (grouped.info?.length > 0) {
            parts.push(`ℹ️  Info (${grouped.info.length}):`);
            grouped.info.forEach(error => {
                parts.push(`  Line ${error.line}: ${error.message} (${error.source})`);
            });
        }

        return parts.join('\n');
    }

    /**
     * Map VSCode severity to our format
     */
    private mapSeverity(severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'info' {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return 'error';
            case vscode.DiagnosticSeverity.Warning:
                return 'warning';
            case vscode.DiagnosticSeverity.Information:
            case vscode.DiagnosticSeverity.Hint:
            default:
                return 'info';
        }
    }

    /**
     * Clear all watchers for a specific file
     */
    clearWatcher(uri: vscode.Uri): void {
        const key = uri.toString();
        const watcher = this.watchers.get(key);
        if (watcher) {
            watcher.dispose();
            this.watchers.delete(key);
        }
    }

    /**
     * Dispose all watchers and cleanup
     */
    dispose(): void {
        this.watchers.forEach(watcher => watcher.dispose());
        this.watchers.clear();
    }
} 