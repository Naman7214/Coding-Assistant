import { calcSlices } from 'fast-myers-diff';
import * as vscode from 'vscode';
import { DiffChange, FileDiff } from '../../types/collectors';

export class DiffGenerator {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Generate line-level diffs between old and new content using fast-myers-diff
     * @param oldContent Previous version of the file
     * @param newContent Current version of the file
     * @param filePath File path for logging purposes
     * @returns Array of FileDiff objects representing added/removed lines
     */
    generateLineDiffs(oldContent: string, newContent: string, filePath: string): FileDiff[] {
        try {
            // Split content into lines for comparison
            const oldLines = oldContent.split('\n');
            const newLines = newContent.split('\n');

            // Use fast-myers-diff to calculate differences
            // calcSlices returns segments with type indicators:
            // -1 = deletion (from old), 0 = common, 1 = insertion (to new)
            const slices = calcSlices(oldLines, newLines);

            const diffs: FileDiff[] = [];
            let currentLineNumber = 1;

            for (const [type, slice] of slices) {
                if (type === -1) {
                    // Deleted lines from old content
                    for (const line of slice) {
                        diffs.push({
                            type: 'removed',
                            lineNumber: currentLineNumber,
                            content: line as string
                        });
                        currentLineNumber++;
                    }
                } else if (type === 1) {
                    // Added lines in new content
                    for (const line of slice) {
                        diffs.push({
                            type: 'added',
                            lineNumber: currentLineNumber,
                            content: line as string
                        });
                        currentLineNumber++;
                    }
                } else if (type === 0) {
                    // Common lines - just increment line number
                    currentLineNumber += slice.length;
                }
            }

            this.outputChannel.appendLine(
                `[DiffGenerator] Generated ${diffs.length} diffs for ${filePath}`
            );

            return diffs;

        } catch (error) {
            this.outputChannel.appendLine(
                `[DiffGenerator] Error generating diffs for ${filePath}: ${error}`
            );
            return [];
        }
    }

    /**
     * Generate a simplified diff summary with added/removed line counts
     */
    generateDiffSummary(oldContent: string, newContent: string): {
        linesAdded: number;
        linesRemoved: number;
        totalChanges: number;
    } {
        try {
            const oldLines = oldContent.split('\n');
            const newLines = newContent.split('\n');
            const slices = calcSlices(oldLines, newLines);

            let linesAdded = 0;
            let linesRemoved = 0;

            for (const [type, slice] of slices) {
                if (type === -1) {
                    linesRemoved += slice.length;
                } else if (type === 1) {
                    linesAdded += slice.length;
                }
            }

            return {
                linesAdded,
                linesRemoved,
                totalChanges: linesAdded + linesRemoved
            };
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error generating diff summary: ${error}`);
            return { linesAdded: 0, linesRemoved: 0, totalChanges: 0 };
        }
    }

    /**
     * Check if two file contents are identical
     */
    isContentIdentical(oldContent: string, newContent: string): boolean {
        return oldContent === newContent;
    }

    /**
     * Generate a contextual diff that includes surrounding lines for better readability
     * @param oldContent Previous version
     * @param newContent Current version
     * @param contextLines Number of context lines to include around changes
     */
    generateContextualDiff(
        oldContent: string,
        newContent: string,
        contextLines: number = 3
    ): Array<{
        type: 'context' | 'added' | 'removed';
        lineNumber: number;
        content: string;
        originalLineNumber?: number;
    }> {
        try {
            const oldLines = oldContent.split('\n');
            const newLines = newContent.split('\n');
            const slices = calcSlices(oldLines, newLines);

            const contextualDiff: Array<{
                type: 'context' | 'added' | 'removed';
                lineNumber: number;
                content: string;
                originalLineNumber?: number;
            }> = [];

            let oldLineNumber = 1;
            let newLineNumber = 1;

            for (const [type, slice] of slices) {
                if (type === 0) {
                    // Common lines - add as context
                    for (let i = 0; i < slice.length; i++) {
                        const line = slice[i] as string;
                        contextualDiff.push({
                            type: 'context',
                            lineNumber: newLineNumber + i,
                            content: line,
                            originalLineNumber: oldLineNumber + i
                        });
                    }
                    oldLineNumber += slice.length;
                    newLineNumber += slice.length;
                } else if (type === -1) {
                    // Removed lines
                    for (let i = 0; i < slice.length; i++) {
                        const line = slice[i] as string;
                        contextualDiff.push({
                            type: 'removed',
                            lineNumber: oldLineNumber + i,
                            content: line,
                            originalLineNumber: oldLineNumber + i
                        });
                    }
                    oldLineNumber += slice.length;
                } else if (type === 1) {
                    // Added lines
                    for (let i = 0; i < slice.length; i++) {
                        const line = slice[i] as string;
                        contextualDiff.push({
                            type: 'added',
                            lineNumber: newLineNumber + i,
                            content: line
                        });
                    }
                    newLineNumber += slice.length;
                }
            }

            return contextualDiff;
        } catch (error) {
            this.outputChannel.appendLine(`[DiffGenerator] Error generating contextual diff: ${error}`);
            return [];
        }
    }

    /**
     * Generate formatted diff strings with --- for removed and +++ for added lines
     * @param oldContent Previous version of the file
     * @param newContent Current version of the file
     * @param filePath File path for the diff header
     * @returns Array of formatted diff strings
     */
    generateFormattedDiffs(oldContent: string, newContent: string, filePath: string): string[] {
        try {
            const oldLines = oldContent.split('\n');
            const newLines = newContent.split('\n');
            const slices = calcSlices(oldLines, newLines);

            const formattedDiffs: string[] = [];
            const fileName = filePath.split('/').pop() || filePath;

            for (const [type, slice] of slices) {
                if (type === -1) {
                    // Removed lines
                    const removedLines = slice.map(line => `- ${line}`).join('\n');
                    formattedDiffs.push(`--- ${fileName} | Removed:\n${removedLines}`);
                } else if (type === 1) {
                    // Added lines
                    const addedLines = slice.map(line => `+ ${line}`).join('\n');
                    formattedDiffs.push(`+++ ${fileName} | Added:\n${addedLines}`);
                }
            }

            return formattedDiffs;

        } catch (error) {
            this.outputChannel.appendLine(
                `[DiffGenerator] Error generating formatted diffs for ${filePath}: ${error}`
            );
            return [];
        }
    }

    /**
     * Generate structured diff changes with startLine, endLine, and content arrays
     * @param oldContent Previous version of the file
     * @param newContent Current version of the file
     * @param filePath File path for logging purposes
     * @returns Array of DiffChange objects with line numbers and content
     */
    generateStructuredDiffs(oldContent: string, newContent: string, filePath: string): DiffChange[] {
        try {
            const oldLines = oldContent.split('\n');
            const newLines = newContent.split('\n');
            const slices = calcSlices(oldLines, newLines);

            const changes: DiffChange[] = [];
            let oldLineNumber = 1;
            let newLineNumber = 1;

            for (const [type, slice] of slices) {
                if (type === -1) {
                    // Removed lines
                    const content = slice.map(line => line as string);
                    changes.push({
                        type: 'removal',
                        startLine: oldLineNumber,
                        endLine: oldLineNumber + content.length - 1,
                        content
                    });
                    oldLineNumber += slice.length;
                } else if (type === 1) {
                    // Added lines
                    const content = slice.map(line => line as string);
                    changes.push({
                        type: 'addition',
                        startLine: newLineNumber,
                        endLine: newLineNumber + content.length - 1,
                        content
                    });
                    newLineNumber += slice.length;
                } else if (type === 0) {
                    // Common lines - just increment line numbers
                    oldLineNumber += slice.length;
                    newLineNumber += slice.length;
                }
            }

            this.outputChannel.appendLine(
                `[DiffGenerator] Generated ${changes.length} structured diff changes for ${filePath}`
            );

            return changes;

        } catch (error) {
            this.outputChannel.appendLine(
                `[DiffGenerator] Error generating structured diffs for ${filePath}: ${error}`
            );
            return [];
        }
    }
}