import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { CollectorMetadata, ProjectStructureCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

export class ProjectStructureCollector extends BaseCollector {
    private fileTypeCategories = {
        source: ['.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.cpp', '.c', '.cs', '.go', '.rs', '.swift', '.kt'],
        config: ['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.config', '.conf'],
        test: ['.test.', '.spec.', '.e2e.'],
        documentation: ['.md', '.txt', '.rst', '.adoc'],
        build: ['webpack', 'vite', 'rollup', 'gulp', 'grunt', 'makefile', 'dockerfile']
    };

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
                    maxDepth: 8,
                    maxFiles: 5000,
                    includeNodeModules: false,
                    includeHiddenFiles: false
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

            this.outputChannel.appendLine(`[${this.name}] Starting simple project structure scan`);

            // Simple directory and file scan
            const structure = await this.scanProjectStructure(workspacePath);

            // Detect basic package info
            const packageInfo = await this.detectBasicPackageInfo(workspacePath);

            const data: ProjectStructureCollectorData = {
                root: workspacePath,
                structure,
                dependencies: [], // Empty - no complex dependency analysis
                packageInfo
            };

            this.outputChannel.appendLine(`[${this.name}] Completed scan: ${structure.files.length} files, ${structure.directories.length} directories`);

            return this.createContextData(
                this.generateId(),
                data,
                {
                    fileCount: structure.files.length,
                    directoryCount: structure.directories.length,
                    dependencyCount: 0,
                    timestamp: Date.now()
                }
            );

        } catch (error) {
            this.error('Failed to collect project structure', error);
            return null; // Return null instead of throwing
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Simple project structure scanner that catalogs files and directories',
            version: '2.0.0',
            dependencies: ['vscode.workspace', 'fs'],
            configurable: true,
            cacheable: true,
            priority: 7
        };
    }

    /**
     * Simple project structure scan
     */
    private async scanProjectStructure(rootPath: string): Promise<{
        directories: ProjectStructureCollectorData['structure']['directories'];
        files: ProjectStructureCollectorData['structure']['files'];
    }> {
        const directories: ProjectStructureCollectorData['structure']['directories'] = [];
        const files: ProjectStructureCollectorData['structure']['files'] = [];
        const maxDepth = this.config.options.maxDepth || 8;
        const maxFiles = this.config.options.maxFiles || 5000;

        const scanDirectory = async (dirPath: string, currentDepth: number = 0): Promise<void> => {
            // Stop if we hit limits
            if (currentDepth > maxDepth || files.length > maxFiles) {
                return;
            }

            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

                for (const entry of entries) {
                    // Skip if we hit file limit
                    if (files.length > maxFiles) {
                        break;
                    }

                    const fullPath = path.join(dirPath, entry.name);
                    const relativePath = this.getRelativePath(fullPath);

                    // Skip unwanted directories/files
                    if (this.shouldSkip(entry.name, relativePath)) {
                        continue;
                    }

                    if (entry.isDirectory()) {
                        // Count files in directory
                        const fileCount = await this.countFiles(fullPath);

                        directories.push({
                            path: fullPath,
                            relativePath,
                            fileCount,
                            importance: this.getDirectoryImportance(entry.name)
                        });

                        // Recurse into subdirectory
                        await scanDirectory(fullPath, currentDepth + 1);

                    } else if (entry.isFile()) {
                        const fileType = this.getFileType(fullPath);

                        files.push({
                            path: fullPath,
                            relativePath,
                            type: fileType,
                            importance: this.getFileImportance(entry.name, fileType)
                        });
                    }
                }
            } catch (error) {
                this.debug(`Cannot scan directory ${dirPath}: ${error}`);
            }
        };

        await scanDirectory(rootPath);
        return { directories, files };
    }

    /**
     * Check if we should skip this file/directory
     */
    private shouldSkip(name: string, relativePath: string): boolean {
        // Skip hidden files unless enabled
        if (!this.config.options.includeHiddenFiles && name.startsWith('.')) {
            return true;
        }

        // Skip node_modules unless enabled
        if (!this.config.options.includeNodeModules && name === 'node_modules') {
            return true;
        }

        // Skip common unwanted directories
        const skipDirs = ['.git', '.vscode', 'dist', 'build', '__pycache__', '.pytest_cache'];
        if (skipDirs.includes(name)) {
            return true;
        }

        return false;
    }

    /**
     * Get file type category
     */
    private getFileType(filePath: string): 'source' | 'config' | 'test' | 'documentation' | 'other' {
        const fileName = path.basename(filePath).toLowerCase();
        const ext = path.extname(filePath).toLowerCase();

        // Check for test files first
        if (this.fileTypeCategories.test.some(pattern => fileName.includes(pattern))) {
            return 'test';
        }

        // Check by extension
        if (this.fileTypeCategories.source.includes(ext)) {
            return 'source';
        }

        if (this.fileTypeCategories.config.includes(ext)) {
            return 'config';
        }

        if (this.fileTypeCategories.documentation.includes(ext)) {
            return 'documentation';
        }

        return 'other';
    }

    /**
     * Get directory importance (simple scoring)
     */
    private getDirectoryImportance(dirName: string): number {
        const importantDirs = ['src', 'lib', 'app', 'components', 'pages', 'api', 'routes'];
        return importantDirs.includes(dirName.toLowerCase()) ? 2 : 1;
    }

    /**
     * Get file importance (simple scoring)
     */
    private getFileImportance(fileName: string, fileType: string): number {
        let importance = 1;

        // Type-based scoring
        switch (fileType) {
            case 'source': importance = 2; break;
            case 'config': importance = 1.5; break;
            case 'documentation': importance = 0.5; break;
            default: importance = 1;
        }

        // Important file names
        const importantNames = ['index', 'main', 'app', 'entry'];
        if (importantNames.some(name => fileName.toLowerCase().includes(name))) {
            importance += 0.5;
        }

        return importance;
    }

    /**
     * Count files in directory (simple count)
     */
    private async countFiles(dirPath: string): Promise<number> {
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            return entries.filter(entry => entry.isFile()).length;
        } catch {
            return 0;
        }
    }

    /**
     * Detect basic package information
     */
    private async detectBasicPackageInfo(workspacePath: string): Promise<ProjectStructureCollectorData['packageInfo']> {
        const packageInfo: ProjectStructureCollectorData['packageInfo'] = {
            managers: [],
            mainFiles: [],
            scripts: {}
        };

        // Check for common package files
        const packageFiles = [
            { file: 'package.json', manager: 'npm' },
            { file: 'requirements.txt', manager: 'pip' },
            { file: 'Cargo.toml', manager: 'cargo' },
            { file: 'go.mod', manager: 'go' }
        ];

        for (const { file, manager } of packageFiles) {
            const filePath = path.join(workspacePath, file);

            try {
                await fs.promises.access(filePath);
                packageInfo.managers.push(manager);

                // Try to parse package.json for additional info
                if (file === 'package.json') {
                    try {
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        const packageJson = JSON.parse(content);

                        if (packageJson.main) {
                            packageInfo.mainFiles.push(packageJson.main);
                        }

                        if (packageJson.scripts && typeof packageJson.scripts === 'object') {
                            packageInfo.scripts = packageJson.scripts;
                        }
                    } catch (parseError) {
                        this.debug(`Could not parse package.json: ${parseError}`);
                    }
                }
            } catch {
                // File doesn't exist, skip
            }
        }

        return packageInfo;
    }
} 