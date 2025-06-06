import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { CollectorMetadata, ProjectStructureCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

interface Directory {
    name: string;
    files: string[];
    directories: Directory[];
}

export class ProjectStructureCollector extends BaseCollector {
    private skipPatterns = [
        'node_modules',
        '.venv',
        '.env',
        '.git',
        '.vscode',
        'dist',
        'build',
        '__pycache__',
        '.pytest_cache',
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

    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string
    ) {
        super(
            'ProjectStructureCollector',
            'project_structure',
            7.0,
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 1800, // 30 minutes cache
                options: {
                    maxDepth: 6,
                    maxFiles: 1000,
                    includeHiddenFiles: false,
                    generateTreeView: true
                }
            }
        );
    }

    async canCollect(): Promise<boolean> {
        return this.isValidVSCodeState();
    }

    async collect(): Promise<ContextData | null> {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!workspacePath) {
                this.debug('No workspace path available');
                return null;
            }

            this.outputChannel.appendLine(`[${this.name}] Starting project structure scan`);

            // Generate tree structure
            const treeStructure = await this.generateProjectTree(workspacePath);

            // Detect basic package info
            const packageInfo = await this.detectBasicPackageInfo(workspacePath);

            const data: ProjectStructureCollectorData = {
                root: workspacePath,
                treeStructure,
                packageInfo
            };

            this.outputChannel.appendLine(`[${this.name}] Completed scan`);

            return this.createContextData(
                this.generateId(),
                data,
                {
                    timestamp: Date.now()
                }
            );

        } catch (error) {
            this.error('Failed to collect project structure', error);
            return null;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Generates a tree-like project structure view',
            version: '2.0.0',
            dependencies: ['vscode.workspace', 'fs'],
            configurable: true,
            cacheable: true,
            priority: 7
        };
    }

    /**
     * Generate a tree-like project structure
     */
    private async generateProjectTree(rootPath: string): Promise<string> {
        const maxDepth = this.config.options.maxDepth || 6;
        const maxFiles = this.config.options.maxFiles || 1000;
        const globalCounter = { count: 0 }; // Use object to pass by reference

        const buildDirectoryTree = async (dirPath: string, depth: number = 0): Promise<Directory | null> => {
            if (depth > maxDepth) {
                return null;
            }

            const directory: Directory = {
                name: path.basename(dirPath),
                files: [],
                directories: []
            };

            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

                // Filter entries
                const filteredEntries = entries.filter(entry => !this.shouldSkip(entry.name));

                // Process files first
                for (const entry of filteredEntries) {
                    if (globalCounter.count >= maxFiles) break;

                    if (entry.isFile()) {
                        directory.files.push(entry.name);
                        globalCounter.count++;
                    }
                }

                // Process directories
                for (const entry of filteredEntries) {
                    if (globalCounter.count >= maxFiles) break;

                    if (entry.isDirectory()) {
                        const subDirectory = await buildDirectoryTree(
                            path.join(dirPath, entry.name),
                            depth + 1
                        );
                        if (subDirectory) {
                            directory.directories.push(subDirectory);
                        }
                    }
                }

                // Sort files and directories alphabetically
                directory.files.sort();
                directory.directories.sort((a, b) => a.name.localeCompare(b.name));

            } catch (error) {
                this.debug(`Cannot scan directory ${dirPath}: ${error}`);
            }

            return directory;
        };

        const formatFileTree = (tree: Directory, indentation: string = ""): string => {
            let result = "";

            // Add files first
            for (const file of tree.files) {
                result += `${indentation}${file}\n`;
            }

            // Add directories
            for (const directory of tree.directories) {
                result += `${indentation}${directory.name}/\n`;
                result += formatFileTree(directory, `${indentation}  `);
            }

            return result;
        };

        // Build the tree starting from root
        const rootTree = await buildDirectoryTree(rootPath);
        if (!rootTree) {
            return "";
        }

        // Format the tree
        let result = `${rootTree.name}/\n`;
        result += formatFileTree(rootTree, "");

        return result.trim();
    }

    /**
     * Check if we should skip this file/directory
     */
    private shouldSkip(name: string): boolean {
        // Skip hidden files unless enabled
        if (!this.config.options.includeHiddenFiles && name.startsWith('.')) {
            // Allow important dotfiles
            const allowedDotFiles = ['.gitignore', '.env.example', '.editorconfig', '.prettierrc'];
            if (!allowedDotFiles.some(allowed => name.startsWith(allowed))) {
                return true;
            }
        }

        // Skip directories/files in skip patterns
        return this.skipPatterns.some(pattern =>
            name === pattern || name.startsWith(pattern)
        );
    }

    /**
     * Detect basic package information from package managers
     */
    private async detectBasicPackageInfo(workspacePath: string): Promise<ProjectStructureCollectorData['packageInfo']> {
        const packageInfo: ProjectStructureCollectorData['packageInfo'] = {
            managers: [],
            mainFiles: [],
            scripts: {}
        };

        try {
            // Check for package.json (Node.js)
            const packageJsonPath = path.join(workspacePath, 'package.json');
            if (await this.fileExists(packageJsonPath)) {
                packageInfo.managers.push('npm');
                try {
                    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
                    if (packageJson.main) {
                        packageInfo.mainFiles.push(packageJson.main);
                    }
                    if (packageJson.scripts) {
                        packageInfo.scripts = { ...packageInfo.scripts, ...packageJson.scripts };
                    }
                } catch (error) {
                    this.debug(`Error reading package.json: ${error}`);
                }
            }

            // Check for requirements.txt (Python)
            if (await this.fileExists(path.join(workspacePath, 'requirements.txt'))) {
                packageInfo.managers.push('pip');
            }

            // Check for Cargo.toml (Rust)
            if (await this.fileExists(path.join(workspacePath, 'Cargo.toml'))) {
                packageInfo.managers.push('cargo');
            }

            // Check for go.mod (Go)
            if (await this.fileExists(path.join(workspacePath, 'go.mod'))) {
                packageInfo.managers.push('go');
            }

            // Check for Gemfile (Ruby)
            if (await this.fileExists(path.join(workspacePath, 'Gemfile'))) {
                packageInfo.managers.push('bundler');
            }

            // Look for common main files
            const commonMainFiles = ['index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts', 'server.js', 'server.ts'];
            for (const mainFile of commonMainFiles) {
                if (await this.fileExists(path.join(workspacePath, mainFile))) {
                    packageInfo.mainFiles.push(mainFile);
                }
            }

        } catch (error) {
            this.debug(`Error detecting package info: ${error}`);
        }

        return packageInfo;
    }

    /**
     * Check if file exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    protected generateCacheKey(): string {
        const workspacePath = this.getWorkspacePath();
        return `${this.type}:${this.workspaceId}:${this.hashString(workspacePath)}`;
    }

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString();
    }

    /**
     * List contents of a specific directory (for list_directory tool)
     */
    public async listSpecificDirectory(dirPath?: string): Promise<{ paths: string[], success: boolean, directory_path: string }> {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!workspacePath) {
                throw new Error('No workspace path available');
            }

            // Use provided directory path or default to workspace root
            const targetDirectory = dirPath ? path.resolve(workspacePath, dirPath) : workspacePath;

            // Security check - ensure directory is within workspace
            if (!targetDirectory.startsWith(workspacePath)) {
                throw new Error('Access denied: Directory is outside workspace');
            }

            // Check if directory exists
            try {
                const stats = await fs.promises.stat(targetDirectory);
                if (!stats.isDirectory()) {
                    throw new Error('Path is not a directory');
                }
            } catch (error) {
                throw new Error(`Directory not found: ${targetDirectory}`);
            }

            this.outputChannel.appendLine(`[${this.name}] Listing directory: ${targetDirectory}`);

            const paths = await this.getDirectoryPaths(targetDirectory);

            return {
                success: true,
                directory_path: dirPath || '.',
                paths: paths
            };

        } catch (error) {
            this.error('Failed to list specific directory', error);
            return {
                success: false,
                directory_path: dirPath || '.',
                paths: []
            };
        }
    }

    /**
     * Get directory paths (used by listSpecificDirectory)
     */
    private async getDirectoryPaths(dirPath: string): Promise<string[]> {
        const paths: string[] = [];

        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

            // Filter entries using existing skip logic
            const filteredEntries = entries.filter(entry => !this.shouldSkip(entry.name));

            // Process all entries (files and directories)
            for (const entry of filteredEntries) {
                const entryPath = path.join(dirPath, entry.name);

                // Return absolute paths as expected by the tool
                if (entry.isDirectory()) {
                    paths.push(entryPath + '/');  // Add trailing slash for directories
                } else {
                    paths.push(entryPath);
                }
            }

            // Sort paths alphabetically
            paths.sort();

        } catch (error) {
            this.debug(`Cannot scan directory ${dirPath}: ${error}`);
        }

        return paths;
    }
} 