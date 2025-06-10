import { calcSlices, diff } from 'fast-myers-diff';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffChange } from '../../types/collectors';

export interface LineRange {
    startLine: number;
    endLine: number;
    content: string[];
}

export interface DiffResult {
    additions: LineRange[];
    deletions: LineRange[];
    totalLinesAdded: number;
    totalLinesRemoved: number;
    hasChanges: boolean;
}

export interface ContextualDiff {
    changes: DiffChange[];
    summary: {
        linesAdded: number;
        linesRemoved: number;
        totalChanges: number;
    };
}

/**
 * Generates line-level diffs using fast-myers-diff algorithm
 * Optimized for code files with contextual output
 */
export class DiffGenerator {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Generate contextual diff between two file contents
     * Returns structured diff data matching the RecentEditsCollectorData interface
     */
    async generateContextualDiff(
        oldContent: string,
        newContent: string,
        filePath: string
    ): Promise<ContextualDiff> {
        try {
            const startTime = Date.now();

            // Split content into lines for line-based comparison
            const oldLines = this.splitIntoLines(oldContent);
            const newLines = this.splitIntoLines(newContent);

            // Use fast-myers-diff calcSlices for getting segments with type indicators
            const segments = Array.from(calcSlices(oldLines, newLines));

            const changes: DiffChange[] = [];
            let linesAdded = 0;
            let linesRemoved = 0;
            let oldLineNumber = 1;  // Track line numbers in old file
            let newLineNumber = 1;  // Track line numbers in new file

            // Process segments to create DiffChange objects with actual file line numbers
            for (const [type, slice] of segments) {
                const lines = Array.isArray(slice) ? slice : [slice];

                if (type === -1) {
                    // Deletion: lines present in old but not in new
                    if (lines.length > 0) {
                        changes.push({
                            type: 'removal',
                            startLine: oldLineNumber,
                            endLine: oldLineNumber + lines.length - 1,
                            content: lines
                        });
                        linesRemoved += lines.length;
                        oldLineNumber += lines.length; // Only advance old line counter
                    }
                } else if (type === 1) {
                    // Addition: lines present in new but not in old
                    if (lines.length > 0) {
                        changes.push({
                            type: 'addition',
                            startLine: newLineNumber,
                            endLine: newLineNumber + lines.length - 1,
                            content: lines
                        });
                        linesAdded += lines.length;
                        newLineNumber += lines.length; // Only advance new line counter
                    }
                } else if (type === 0) {
                    // Common lines: present in both, advance both counters
                    oldLineNumber += lines.length;
                    newLineNumber += lines.length;
                }
            }

            const duration = Date.now() - startTime;

            this.outputChannel.appendLine(
                `[DiffGenerator] Generated diff for ${path.basename(filePath)} ` +
                `(${duration}ms): +${linesAdded}, -${linesRemoved} lines, ${changes.length} changes with actual line numbers`
            );

            return {
                changes,
                summary: {
                    linesAdded,
                    linesRemoved,
                    totalChanges: changes.length
                }
            };
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error generating diff for ${filePath}: ${error}`);
            return {
                changes: [],
                summary: {
                    linesAdded: 0,
                    linesRemoved: 0,
                    totalChanges: 0
                }
            };
        }
    }

    /**
     * Generate simple diff result for basic analysis
     */
    async generateSimpleDiff(
        oldContent: string,
        newContent: string,
        filePath: string
    ): Promise<DiffResult> {
        try {
            const startTime = Date.now();

            const oldLines = this.splitIntoLines(oldContent);
            const newLines = this.splitIntoLines(newContent);

            // Use fast-myers-diff core diff function
            const diffResults = Array.from(diff(oldLines, newLines));

            const additions: LineRange[] = [];
            const deletions: LineRange[] = [];
            let totalLinesAdded = 0;
            let totalLinesRemoved = 0;

            // Process diff results
            for (const [deleteStart, deleteEnd, insertStart, insertEnd] of diffResults) {
                // Handle deletions
                if (deleteStart < deleteEnd) {
                    const deletedLines = oldLines.slice(deleteStart, deleteEnd);
                    deletions.push({
                        startLine: deleteStart + 1, // Convert to 1-based line numbers
                        endLine: deleteEnd,
                        content: deletedLines
                    });
                    totalLinesRemoved += deletedLines.length;
                }

                // Handle insertions
                if (insertStart < insertEnd) {
                    const insertedLines = newLines.slice(insertStart, insertEnd);
                    additions.push({
                        startLine: insertStart + 1, // Convert to 1-based line numbers
                        endLine: insertEnd,
                        content: insertedLines
                    });
                    totalLinesAdded += insertedLines.length;
                }
            }

            const duration = Date.now() - startTime;
            const hasChanges = additions.length > 0 || deletions.length > 0;

            this.outputChannel.appendLine(
                `[DiffGenerator] Simple diff for ${path.basename(filePath)} ` +
                `(${duration}ms): ${hasChanges ? `+${totalLinesAdded}, -${totalLinesRemoved}` : 'no changes'}`
            );

            return {
                additions,
                deletions,
                totalLinesAdded,
                totalLinesRemoved,
                hasChanges
            };
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error in simple diff for ${filePath}: ${error}`);
            return {
                additions: [],
                deletions: [],
                totalLinesAdded: 0,
                totalLinesRemoved: 0,
                hasChanges: false
            };
        }
    }

    /**
     * Generate unified diff format for display purposes
     */
    async generateUnifiedDiff(
        oldContent: string,
        newContent: string,
        filePath: string,
        contextLines: number = 3
    ): Promise<string> {
        try {
            const oldLines = this.splitIntoLines(oldContent);
            const newLines = this.splitIntoLines(newContent);

            // Use calcSlices to get segments with type indicators
            const segments = Array.from(calcSlices(oldLines, newLines));

            const unifiedLines: string[] = [];
            unifiedLines.push(`--- a/${path.basename(filePath)}`);
            unifiedLines.push(`+++ b/${path.basename(filePath)}`);

            let oldLineNum = 1;
            let newLineNum = 1;

            for (const [type, slice] of segments) {
                const lines = Array.isArray(slice) ? slice : [slice];

                if (type === -1) {
                    // Deleted lines
                    for (const line of lines) {
                        unifiedLines.push(`-${line}`);
                        oldLineNum++;
                    }
                } else if (type === 1) {
                    // Added lines
                    for (const line of lines) {
                        unifiedLines.push(`+${line}`);
                        newLineNum++;
                    }
                } else {
                    // Common lines
                    for (const line of lines) {
                        unifiedLines.push(` ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                }
            }

            return unifiedLines.join('\n');
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error generating unified diff for ${filePath}: ${error}`);
            return '';
        }
    }

    /**
     * Check if two files are identical
     */
    filesAreIdentical(content1: string, content2: string): boolean {
        return content1 === content2;
    }

    /**
     * Get diff statistics
     */
    getDiffStats(diffResult: DiffResult): {
        addedLines: number;
        removedLines: number;
        changedChunks: number;
        changeRatio: number;
    } {
        const totalOriginalLines = diffResult.totalLinesRemoved +
            (diffResult.totalLinesAdded - diffResult.totalLinesRemoved);

        return {
            addedLines: diffResult.totalLinesAdded,
            removedLines: diffResult.totalLinesRemoved,
            changedChunks: diffResult.additions.length + diffResult.deletions.length,
            changeRatio: totalOriginalLines > 0 ?
                (diffResult.totalLinesAdded + diffResult.totalLinesRemoved) / totalOriginalLines : 0
        };
    }

    /**
     * Generate diff for multiple files in batch
     */
    async generateBatchDiffs(
        fileDiffs: Array<{
            filePath: string;
            oldContent: string;
            newContent: string;
        }>
    ): Promise<Map<string, ContextualDiff>> {
        const results = new Map<string, ContextualDiff>();
        const startTime = Date.now();

        this.outputChannel.appendLine(`[DiffGenerator] Starting batch diff generation for ${fileDiffs.length} files`);

        for (const { filePath, oldContent, newContent } of fileDiffs) {
            try {
                const diff = await this.generateContextualDiff(oldContent, newContent, filePath);
                results.set(filePath, diff);
            } catch (error) {
                this.outputChannel.appendLine(`[DiffGenerator] Error in batch diff for ${filePath}: ${error}`);
                // Set empty diff for failed files
                results.set(filePath, {
                    changes: [],
                    summary: { linesAdded: 0, linesRemoved: 0, totalChanges: 0 }
                });
            }
        }

        const duration = Date.now() - startTime;
        const totalChanges = Array.from(results.values())
            .reduce((sum, diff) => sum + diff.summary.totalChanges, 0);

        this.outputChannel.appendLine(
            `[DiffGenerator] Batch diff completed (${duration}ms): ` +
            `${results.size} files, ${totalChanges} total changes`
        );

        return results;
    }

    /**
     * Split content into lines while preserving empty lines
     */
    private splitIntoLines(content: string): string[] {
        if (!content) {
            return [];
        }

        // Split on line breaks and preserve empty lines
        const lines = content.split(/\r?\n/);

        // Remove the last empty line if content doesn't end with newline
        if (lines.length > 0 && lines[lines.length - 1] === '' && !content.endsWith('\n')) {
            lines.pop();
        }

        return lines;
    }

    /**
     * Normalize line endings for consistent comparison
     */
    private normalizeLineEndings(content: string): string {
        return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    /**
     * Calculate similarity ratio between two contents
     */
    calculateSimilarity(content1: string, content2: string): number {
        if (content1 === content2) {
            return 1.0;
        }

        const lines1 = this.splitIntoLines(content1);
        const lines2 = this.splitIntoLines(content2);

        if (lines1.length === 0 && lines2.length === 0) {
            return 1.0;
        }

        if (lines1.length === 0 || lines2.length === 0) {
            return 0.0;
        }

        try {
            // Use fast-myers-diff to calculate common subsequences
            const segments = Array.from(calcSlices(lines1, lines2));
            let commonLines = 0;

            for (const [type, slice] of segments) {
                if (type === 0) { // Common lines
                    const lines = Array.isArray(slice) ? slice : [slice];
                    commonLines += lines.length;
                }
            }

            const totalLines = Math.max(lines1.length, lines2.length);
            return totalLines > 0 ? commonLines / totalLines : 0.0;
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error calculating similarity: ${error}`);
            return 0.0;
        }
    }

    /**
     * Extract context around changes for better readability
     */
    async generateContextualChanges(
        oldContent: string,
        newContent: string,
        filePath: string,
        contextLines: number = 3
    ): Promise<DiffChange[]> {
        try {
            const contextDiff = await this.generateContextualDiff(oldContent, newContent, filePath);
            const oldLines = this.splitIntoLines(oldContent);
            const newLines = this.splitIntoLines(newContent);

            // Add context lines around each change
            const enhancedChanges: DiffChange[] = [];

            for (const change of contextDiff.changes) {
                const contextualChange: DiffChange = {
                    ...change,
                    content: [
                        // Add context before
                        ...this.getContextLines(oldLines, change.startLine - 1, contextLines, 'before'),
                        // Add the actual change
                        ...change.content,
                        // Add context after
                        ...this.getContextLines(oldLines, change.endLine, contextLines, 'after')
                    ]
                };

                enhancedChanges.push(contextualChange);
            }

            return enhancedChanges;
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error generating contextual changes: ${error}`);
            return [];
        }
    }

    /**
     * Get context lines around a change
     */
    private getContextLines(
        lines: string[],
        lineIndex: number,
        contextCount: number,
        direction: 'before' | 'after'
    ): string[] {
        if (direction === 'before') {
            const start = Math.max(0, lineIndex - contextCount);
            const end = lineIndex;
            return lines.slice(start, end);
        } else {
            const start = lineIndex;
            const end = Math.min(lines.length, lineIndex + contextCount);
            return lines.slice(start, end);
        }
    }
}
