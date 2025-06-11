import * as path from 'path';
import * as vscode from 'vscode';
import {
    ContextMention,
    ContextMentionType,
    ContextSuggestion,
    FileTreeItem
} from '../types/contextMentions';

export interface ParsedQuery {
    originalQuery: string;
    cleanQuery: string; // Query with @ mentions removed
    mentions: ContextMention[];
}

export class ContextMentionParser {
    private outputChannel: vscode.OutputChannel;
    private workspacePath: string;

    constructor(outputChannel: vscode.OutputChannel, workspacePath: string) {
        this.outputChannel = outputChannel;
        this.workspacePath = workspacePath;
    }

    /**
     * Parse query for @ mentions and extract them
     */
    parseQuery(query: string): ParsedQuery {
        this.outputChannel.appendLine(`[ContextMentionParser] Parsing query: ${query}`);

        const mentions: ContextMention[] = [];
        let cleanQuery = query;

        // Regex to match @ mentions: @word, @path/to/file, @file.ext, etc.
        const atMentionRegex = /@([^\s]+)/g;
        let match;

        while ((match = atMentionRegex.exec(query)) !== null) {
            const mentionText = match[1]; // The part after @
            const fullMatch = match[0]; // The full @ mention including @

            try {
                const mention = this.parseSingleMention(mentionText);
                if (mention) {
                    mentions.push(mention);
                    // Remove the mention from the clean query
                    cleanQuery = cleanQuery.replace(fullMatch, '').trim();
                }
            } catch (error) {
                this.outputChannel.appendLine(`[ContextMentionParser] Failed to parse mention '${mentionText}': ${error}`);
                // Keep the mention in the query if we can't parse it
            }
        }

        // Clean up extra whitespace
        cleanQuery = cleanQuery.replace(/\s+/g, ' ').trim();

        const result: ParsedQuery = {
            originalQuery: query,
            cleanQuery: cleanQuery,
            mentions: mentions
        };

        this.outputChannel.appendLine(`[ContextMentionParser] Parsed ${mentions.length} mentions`);
        return result;
    }

    /**
     * Parse a single @ mention
     */
    private parseSingleMention(mentionText: string): ContextMention | null {
        const lowerMention = mentionText.toLowerCase();

        // Check for predefined context types first
        if (this.isGitMention(lowerMention)) {
            return {
                type: ContextMentionType.GIT,
                value: 'git',
                label: '@git',
                resolved: false
            };
        }

        if (this.isProjectMention(lowerMention)) {
            return {
                type: ContextMentionType.PROJECT,
                value: 'project',
                label: '@project',
                resolved: false
            };
        }

        if (this.isWebMention(lowerMention)) {
            return {
                type: ContextMentionType.WEB,
                value: 'web',
                label: '@web',
                resolved: false
            };
        }

        // Check if it looks like a file or directory path
        if (this.looksLikeFilePath(mentionText)) {
            const isDirectory = mentionText.endsWith('/') || mentionText.endsWith('\\');

            if (isDirectory) {
                // Remove trailing slash for processing
                const cleanPath = mentionText.replace(/[\/\\]$/, '');
                return {
                    type: ContextMentionType.DIRECTORY,
                    value: cleanPath,
                    label: `@${mentionText}`,
                    resolved: false
                };
            } else {
                return {
                    type: ContextMentionType.FILE,
                    value: mentionText,
                    label: `@${mentionText}`,
                    resolved: false
                };
            }
        }

        // If we can't determine the type, treat it as a potential file
        return {
            type: ContextMentionType.FILE,
            value: mentionText,
            label: `@${mentionText}`,
            resolved: false
        };
    }

    /**
     * Generate context suggestions based on current input
     */
    generateContextSuggestions(query: string, cursorPosition: number): ContextSuggestion[] {
        const suggestions: ContextSuggestion[] = [];

        // Find if cursor is after an @ symbol
        const beforeCursor = query.substring(0, cursorPosition);
        const atMatch = beforeCursor.match(/@([^\s]*)$/);

        if (!atMatch) {
            // Not in a mention context, return basic suggestions
            return this.getBasicSuggestions();
        }

        const partialMention = atMatch[1].toLowerCase();

        // Filter basic suggestions based on partial input
        const basicSuggestions = this.getBasicSuggestions().filter(suggestion =>
            suggestion.label.toLowerCase().includes(partialMention) ||
            suggestion.value.toLowerCase().includes(partialMention)
        );

        suggestions.push(...basicSuggestions);

        return suggestions;
    }

    /**
     * Get basic context suggestions
     */
    private getBasicSuggestions(): ContextSuggestion[] {
        return [
            {
                type: ContextMentionType.FILE,
                label: 'Files',
                value: 'files',
                description: 'Browse and select files from workspace',
                icon: 'file'
            },
            {
                type: ContextMentionType.DIRECTORY,
                label: 'Directories',
                value: 'directories',
                description: 'Browse and select directories from workspace',
                icon: 'folder'
            },
            {
                type: ContextMentionType.GIT,
                label: 'Git Context',
                value: 'git',
                description: 'Include git repository information and changes',
                icon: 'git-branch'
            },
            {
                type: ContextMentionType.PROJECT,
                label: 'Project Structure',
                value: 'project',
                description: 'Include project file tree and structure',
                icon: 'project'
            },
            {
                type: ContextMentionType.WEB,
                label: 'Web Search',
                value: 'web',
                description: 'Enable web search capabilities',
                icon: 'globe'
            }
        ];
    }

    /**
     * Check if mention refers to git context
     */
    private isGitMention(mention: string): boolean {
        const gitKeywords = ['git', 'repository', 'repo', 'branch', 'commit', 'diff', 'changes'];
        return gitKeywords.includes(mention);
    }

    /**
     * Check if mention refers to project structure
     */
    private isProjectMention(mention: string): boolean {
        const projectKeywords = ['project', 'structure', 'tree', 'files', 'folders', 'architecture'];
        return projectKeywords.includes(mention);
    }

    /**
     * Check if mention refers to web search
     */
    private isWebMention(mention: string): boolean {
        const webKeywords = ['web', 'search', 'internet', 'online', 'browse'];
        return webKeywords.includes(mention);
    }

    /**
     * Check if text looks like a file path
     */
    private looksLikeFilePath(text: string): boolean {
        // Check for file extension
        if (/\.[a-zA-Z0-9]+$/.test(text)) {
            return true;
        }

        // Check for path separators
        if (text.includes('/') || text.includes('\\')) {
            return true;
        }

        // Check for common file patterns
        const filePatterns = [
            /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/, // filename.ext
            /^[a-zA-Z0-9_.-]+\//, // starts with directory/
            /\/[a-zA-Z0-9_.-]+$/, // ends with /filename
        ];

        return filePatterns.some(pattern => pattern.test(text));
    }

    /**
     * Create mention from file tree item
     */
    createMentionFromFileItem(item: FileTreeItem): ContextMention {
        return {
            type: item.type === 'directory' ? ContextMentionType.DIRECTORY : ContextMentionType.FILE,
            value: item.relativePath,
            label: `@${item.relativePath}${item.type === 'directory' ? '/' : ''}`,
            resolved: false
        };
    }

    /**
     * Validate if a mention path exists in workspace
     */
    async validateMentionPath(mention: ContextMention): Promise<boolean> {
        if (mention.type !== ContextMentionType.FILE && mention.type !== ContextMentionType.DIRECTORY) {
            return true; // Other types don't need path validation
        }

        try {
            const absolutePath = path.isAbsolute(mention.value)
                ? mention.value
                : path.resolve(this.workspacePath, mention.value);

            // Security check
            if (!absolutePath.startsWith(this.workspacePath)) {
                return false;
            }

            // Check if file/directory exists
            const uri = vscode.Uri.file(absolutePath);
            const stat = await vscode.workspace.fs.stat(uri);

            // Validate type matches
            if (mention.type === ContextMentionType.FILE && stat.type !== vscode.FileType.File) {
                return false;
            }
            if (mention.type === ContextMentionType.DIRECTORY && stat.type !== vscode.FileType.Directory) {
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Normalize file path for consistent handling
     */
    normalizePath(filePath: string): string {
        // Convert backslashes to forward slashes
        const normalized = filePath.replace(/\\/g, '/');

        // Remove leading ./ if present
        return normalized.startsWith('./') ? normalized.substring(2) : normalized;
    }

    /**
     * Extract file extension for language detection
     */
    getFileExtension(filePath: string): string {
        return path.extname(filePath).toLowerCase();
    }

    /**
     * Check if file should be excluded based on common patterns
     */
    shouldExcludeFile(filePath: string): boolean {
        const excludePatterns = [
            /node_modules/,
            /\.git/,
            /\.vscode/,
            /\.venv/,
            /__pycache__/,
            /\.pytest_cache/,
            /dist/,
            /build/,
            /out/,
            /\.next/,
            /\.nuxt/,
            /target/,
            /bin/,
            /obj/,
            /\.idea/,
            /\.vs/,
            /coverage/,
            /\.nyc_output/,
            /temp/,
            /tmp/
        ];

        return excludePatterns.some(pattern => pattern.test(filePath));
    }
} 