import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextManager } from '../context/ContextManager';
import {
    ContextMention,
    ContextMentionResult,
    ContextMentionType,
    DirectoryContextData,
    FileContextData,
    FileTreeItem,
    GitContextData,
    ProjectContextData,
    WebContextData
} from '../types/contextMentions';

export class ContextResolver {
    private contextManager: ContextManager;
    private outputChannel: vscode.OutputChannel;
    private workspacePath: string;

    constructor(
        contextManager: ContextManager,
        outputChannel: vscode.OutputChannel,
        workspacePath: string
    ) {
        this.contextManager = contextManager;
        this.outputChannel = outputChannel;
        this.workspacePath = workspacePath;
    }

    /**
     * Resolve all context mentions in parallel
     */
    async resolveContextMentions(mentions: ContextMention[]): Promise<ContextMentionResult> {
        this.outputChannel.appendLine(`[ContextResolver] Resolving ${mentions.length} context mentions`);

        const result: ContextMentionResult = {
            mentions: [],
            resolvedCount: 0,
            errors: []
        };

        // Resolve all mentions in parallel for better performance
        const resolvePromises = mentions.map(mention => this.resolveSingleMention(mention));
        const resolvedMentions = await Promise.allSettled(resolvePromises);

        for (let i = 0; i < resolvedMentions.length; i++) {
            const promiseResult = resolvedMentions[i];
            const originalMention = mentions[i];

            if (promiseResult.status === 'fulfilled') {
                result.mentions.push(promiseResult.value);
                if (promiseResult.value.resolved) {
                    result.resolvedCount++;
                }
            } else {
                // Handle failed resolution
                const failedMention = { ...originalMention };
                failedMention.resolved = false;
                failedMention.error = promiseResult.reason?.message || 'Unknown error';
                result.mentions.push(failedMention);
                result.errors.push(`Failed to resolve ${originalMention.label}: ${failedMention.error}`);
            }
        }

        this.outputChannel.appendLine(`[ContextResolver] Resolved ${result.resolvedCount}/${mentions.length} mentions`);
        return result;
    }

    /**
     * Resolve a single context mention
     */
    private async resolveSingleMention(mention: ContextMention): Promise<ContextMention> {
        this.outputChannel.appendLine(`[ContextResolver] Resolving ${mention.type}: ${mention.value}`);

        const resolvedMention = { ...mention };

        try {
            switch (mention.type) {
                case ContextMentionType.FILE:
                    resolvedMention.data = await this.resolveFileContext(mention.value);
                    break;

                case ContextMentionType.DIRECTORY:
                    resolvedMention.data = await this.resolveDirectoryContext(mention.value);
                    break;

                case ContextMentionType.GIT:
                    resolvedMention.data = await this.resolveGitContext();
                    break;

                case ContextMentionType.PROJECT:
                    resolvedMention.data = await this.resolveProjectContext();
                    break;

                case ContextMentionType.WEB:
                    resolvedMention.data = await this.resolveWebContext();
                    break;

                default:
                    throw new Error(`Unknown context mention type: ${mention.type}`);
            }

            resolvedMention.resolved = true;
            this.outputChannel.appendLine(`[ContextResolver] Successfully resolved ${mention.type}: ${mention.value}`);

        } catch (error) {
            resolvedMention.resolved = false;
            resolvedMention.error = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[ContextResolver] Failed to resolve ${mention.type}: ${resolvedMention.error}`);
        }

        return resolvedMention;
    }

    /**
     * Resolve file context - get first 100 lines + metadata
     */
    private async resolveFileContext(filePath: string): Promise<FileContextData> {
        // Resolve absolute path
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(this.workspacePath, filePath);

        // Security check - ensure file is within workspace
        if (!absolutePath.startsWith(this.workspacePath)) {
            throw new Error('File is outside workspace');
        }

        // Check if file exists
        if (!await this.fileExists(absolutePath)) {
            throw new Error('File not found');
        }

        const stats = await fs.promises.stat(absolutePath);
        const relativePath = path.relative(this.workspacePath, absolutePath);

        // Read file content
        const fullContent = await fs.promises.readFile(absolutePath, 'utf8');
        const lines = fullContent.split('\n');

        // Get first 100 lines
        const first100Lines = lines.slice(0, 100).join('\n');

        // Detect language based on file extension
        const language = this.detectLanguage(absolutePath);

        return {
            path: absolutePath,
            relativePath: relativePath,
            content: first100Lines,
            totalLines: lines.length,
            size: stats.size,
            language: language
        };
    }

    /**
     * Resolve directory context - get list of files and directories
     */
    private async resolveDirectoryContext(dirPath: string): Promise<DirectoryContextData> {
        // Resolve absolute path
        const absolutePath = path.isAbsolute(dirPath)
            ? dirPath
            : path.resolve(this.workspacePath, dirPath);

        // Security check - ensure directory is within workspace
        if (!absolutePath.startsWith(this.workspacePath)) {
            throw new Error('Directory is outside workspace');
        }

        // Check if directory exists
        if (!await this.fileExists(absolutePath)) {
            throw new Error('Directory not found');
        }

        const stats = await fs.promises.stat(absolutePath);
        if (!stats.isDirectory()) {
            throw new Error('Path is not a directory');
        }

        const relativePath = path.relative(this.workspacePath, absolutePath);

        // Read directory contents
        const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });

        const files: string[] = [];
        const directories: string[] = [];

        for (const entry of entries) {
            // Skip hidden files and common ignore patterns
            if (this.shouldSkipEntry(entry.name)) {
                continue;
            }

            const entryPath = path.join(absolutePath, entry.name);
            const relativeEntryPath = path.relative(this.workspacePath, entryPath);

            if (entry.isFile()) {
                files.push(relativeEntryPath);
            } else if (entry.isDirectory()) {
                directories.push(relativeEntryPath);
            }
        }

        return {
            path: absolutePath,
            relativePath: relativePath,
            files: files.sort(),
            directories: directories.sort(),
            totalItems: files.length + directories.length
        };
    }

    /**
     * Resolve git context using GitContextCollector
     */
    private async resolveGitContext(): Promise<GitContextData> {
        const gitCollectionResult = await this.contextManager.collectSpecificContext('gitContext');

        if (!gitCollectionResult || !gitCollectionResult.data) {
            throw new Error('Failed to collect git context');
        }

        const gitData = gitCollectionResult.data;

        return {
            branch: gitData.repository?.currentBranch || 'unknown',
            hasChanges: gitData.status?.hasUncommittedChanges || false,
            stagedChanges: gitData.diff?.stagedChanges || '',
            unstagedChanges: gitData.diff?.unstagedChanges || '',
            recentCommits: gitData.history?.recentCommits || [],
            conflictFiles: gitData.diff?.conflictFiles || []
        };
    }

    /**
     * Resolve project structure using ProjectStructureCollector
     */
    private async resolveProjectContext(): Promise<ProjectContextData> {
        const projectCollectionResult = await this.contextManager.collectSpecificContext('projectStructure');

        if (!projectCollectionResult || !projectCollectionResult.data) {
            throw new Error('Failed to collect project structure');
        }

        const projectData = projectCollectionResult.data;

        return {
            root: this.workspacePath,
            treeStructure: projectData.treeStructure || ''
        };
    }

    /**
     * Resolve web context - just return instruction
     */
    private async resolveWebContext(): Promise<WebContextData> {
        return {
            instruction: "You can use the web search tool when needed to get real-time information."
        };
    }

    /**
     * Get file tree for directory browsing
     */
    async getFileTree(targetPath?: string, maxDepth: number = 3): Promise<FileTreeItem[]> {
        const rootPath = targetPath
            ? path.resolve(this.workspacePath, targetPath)
            : this.workspacePath;

        // Security check
        if (!rootPath.startsWith(this.workspacePath)) {
            throw new Error('Path is outside workspace');
        }

        return await this.buildFileTree(rootPath, 0, maxDepth);
    }

    /**
     * Build file tree recursively
     */
    private async buildFileTree(dirPath: string, currentDepth: number, maxDepth: number): Promise<FileTreeItem[]> {
        if (currentDepth > maxDepth) {
            return [];
        }

        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const items: FileTreeItem[] = [];

            for (const entry of entries) {
                if (this.shouldSkipEntry(entry.name)) {
                    continue;
                }

                const entryPath = path.join(dirPath, entry.name);
                const relativePath = path.relative(this.workspacePath, entryPath);

                const item: FileTreeItem = {
                    name: entry.name,
                    path: entryPath,
                    relativePath: relativePath,
                    type: entry.isDirectory() ? 'directory' : 'file'
                };

                if (entry.isFile()) {
                    const stats = await fs.promises.stat(entryPath);
                    item.size = stats.size;
                    item.language = this.detectLanguage(entryPath);
                } else if (entry.isDirectory() && currentDepth < maxDepth) {
                    item.children = await this.buildFileTree(entryPath, currentDepth + 1, maxDepth);
                }

                items.push(item);
            }

            // Sort: directories first, then files, both alphabetically
            return items.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'directory' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });

        } catch (error) {
            this.outputChannel.appendLine(`[ContextResolver] Failed to read directory ${dirPath}: ${error}`);
            return [];
        }
    }

    /**
     * Check if file/directory exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Detect programming language from file extension
     */
    private detectLanguage(filePath: string): string | undefined {
        const ext = path.extname(filePath).toLowerCase();
        const languageMap: Record<string, string> = {
            '.js': 'javascript',
            '.ts': 'typescript',
            '.jsx': 'javascriptreact',
            '.tsx': 'typescriptreact',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.cs': 'csharp',
            '.php': 'php',
            '.rb': 'ruby',
            '.go': 'go',
            '.rs': 'rust',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.sass': 'sass',
            '.json': 'json',
            '.xml': 'xml',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.md': 'markdown',
            '.sh': 'shellscript',
            '.sql': 'sql'
        };

        return languageMap[ext];
    }

    /**
     * Check if entry should be skipped
     */
    private shouldSkipEntry(name: string): boolean {
        const skipPatterns = [
            'node_modules',
            '.git',
            '.vscode',
            '.venv',
            '__pycache__',
            '.pytest_cache',
            'dist',
            'build',
            'out',
            '.next',
            '.nuxt',
            'target',
            'bin',
            'obj',
            '.idea',
            '.vs',
            'coverage',
            '.nyc_output',
            'temp',
            'tmp'
        ];

        // Skip hidden files unless they're important dotfiles
        if (name.startsWith('.')) {
            const allowedDotFiles = ['.gitignore', '.env.example', '.editorconfig', '.prettierrc'];
            return !allowedDotFiles.some(allowed => name.startsWith(allowed));
        }

        return skipPatterns.some(pattern => name === pattern || name.startsWith(pattern));
    }
} 