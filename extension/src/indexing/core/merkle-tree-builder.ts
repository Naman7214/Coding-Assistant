import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MerkleTreeNode, TreeComparisonResult } from '../types/chunk';
import { combineHashes, hashFile } from '../utils/hash';

export class MerkleTreeBuilder {
    private excludePatterns: string[];
    private includePatterns: string[];
    private outputChannel?: vscode.OutputChannel;

    constructor(excludePatterns: string[] = [], includePatterns: string[] = [], outputChannel?: vscode.OutputChannel) {
        this.excludePatterns = [
            ...excludePatterns,
            // Version control and git
            '.git/**',
            '**/.git/**',

            // Node.js dependencies and build artifacts
            'node_modules/**',
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/out/**',
            '**/.next/**',
            '**/.nuxt/**',

            // Python virtual environments and cache
            '.venv/**',
            '**/.venv/**',
            'venv/**',
            '**/venv/**',
            'env/**',
            '**/env/**',
            '**/site-packages/**',
            '**/lib/python*/**',
            '**/bin/**',
            '**/__pycache__/**',
            '**/*.pyc',
            '**/.pytest_cache/**',

            // IDE and editor directories
            '.vscode/**',
            '**/.vscode/**',
            '.idea/**',
            '**/.idea/**',
            '.vs/**',
            '**/.vs/**',

            // Cache and temporary directories
            '**/.cache/**',
            '**/tmp/**',
            '**/temp/**',
            '**/coverage/**',
            '**/.nyc_output/**',

            // System and misc files
            '**/.DS_Store',
            '**/thumbs.db',
            '**/*.log',

            // Snapshot directories (prevent recursive snapshots)
            '**/.snapshots/**'
        ];
        this.includePatterns = includePatterns.length > 0 ? includePatterns : [
            '**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx',
            '**/*.py', '**/*.java', '**/*.cpp', '**/*.c',
            '**/*.cs', '**/*.php', '**/*.rb', '**/*.go',
            '**/*.rust', '**/*.swift', '**/*.kt'
        ];
        this.outputChannel = outputChannel;
    }

    /**
     * Build merkle tree for the given directory
     */
    async buildTree(rootPath: string): Promise<MerkleTreeNode> {
        const stats = await fs.promises.stat(rootPath);

        if (stats.isFile()) {
            if (this.shouldIncludeFile(rootPath)) {
                const fileHash = await hashFile(rootPath);
                return {
                    hash: fileHash,
                    filePath: rootPath,
                    lastModified: stats.mtime.getTime(),
                    fileSize: stats.size
                };
            }
            throw new Error(`File ${rootPath} should not be included`);
        }

        if (stats.isDirectory()) {
            const children: MerkleTreeNode[] = [];
            const entries = await fs.promises.readdir(rootPath);

            for (const entry of entries) {
                const fullPath = path.join(rootPath, entry);

                if (this.shouldExcludePath(fullPath)) {
                    continue;
                }

                try {
                    const childNode = await this.buildTree(fullPath);
                    children.push(childNode);
                } catch (error) {
                    // Skip files that shouldn't be included or cause errors
                    continue;
                }
            }

            // Calculate directory hash from children hashes
            const childHashes = children.map(child => child.hash);
            const directoryHash = childHashes.length > 0 ? combineHashes(childHashes) : 'empty-dir';

            // Only log non-excluded directories that have children
            if (children.length > 0 && !this.shouldExcludePath(rootPath)) {
                const logMessage = `[MerkleTreeBuilder] ${path.basename(rootPath)}: found ${children.length} code files`;
                if (this.outputChannel) {
                    this.outputChannel.appendLine(logMessage);
                } else {
                    console.log(logMessage);
                }
            }

            return {
                hash: directoryHash,
                filePath: rootPath,
                lastModified: stats.mtime.getTime(),
                fileSize: stats.size,
                children: children
            };
        }

        throw new Error(`Unsupported file type: ${rootPath}`);
    }

    /**
     * Compare two merkle trees and find changed and deleted files
     */
    compareTree(oldTree: MerkleTreeNode | null, newTree: MerkleTreeNode): TreeComparisonResult {
        const changedFiles: string[] = [];
        const deletedFiles: string[] = [];

        if (!oldTree) {
            // If no old tree, all files are new
            this.collectAllFiles(newTree, changedFiles);
            return { changedFiles, deletedFiles };
        }

        this.compareNodes(oldTree, newTree, changedFiles, deletedFiles);
        return { changedFiles, deletedFiles };
    }

    private compareNodes(oldNode: MerkleTreeNode, newNode: MerkleTreeNode, changedFiles: string[], deletedFiles: string[]): void {
        // If hashes are different, investigate further
        if (oldNode.hash !== newNode.hash) {
            // If it's a file, add to changed files
            if (!newNode.children) {
                changedFiles.push(newNode.filePath);
                return;
            }

            // If it's a directory, compare children
            const oldChildren = oldNode.children || [];
            const newChildren = newNode.children || [];

            // Create maps for easier comparison
            const oldChildMap = new Map(oldChildren.map(child => [child.filePath, child]));
            const newChildMap = new Map(newChildren.map(child => [child.filePath, child]));

            // Check for modified and new files
            for (const [filePath, newChild] of newChildMap) {
                const oldChild = oldChildMap.get(filePath);
                if (oldChild) {
                    this.compareNodes(oldChild, newChild, changedFiles, deletedFiles);
                } else {
                    // New file/directory
                    this.collectAllFiles(newChild, changedFiles);
                }
            }

            // Check for deleted files (exist in old but not in new)
            for (const [filePath, oldChild] of oldChildMap) {
                if (!newChildMap.has(filePath)) {
                    // File was deleted - collect all files in the deleted subtree
                    this.collectAllFiles(oldChild, deletedFiles);
                }
            }
        }
    }

    private collectAllFiles(node: MerkleTreeNode, files: string[]): void {
        if (!node.children) {
            // It's a file
            files.push(node.filePath);
        } else {
            // It's a directory, recurse into children
            for (const child of node.children) {
                this.collectAllFiles(child, files);
            }
        }
    }

    private shouldExcludePath(filePath: string): boolean {
        const normalizedPath = path.normalize(filePath).replace(/\\/g, '/');
        const baseName = path.basename(filePath);

        // Quick exclusions for common directories
        const excludedDirs = [
            '.git', 'node_modules', '.venv', 'venv', 'env',
            'site-packages', '__pycache__', 'bin', 'lib',
            '.vscode', '.idea', '.vs', 'dist', 'build', 'out',
            '.next', '.nuxt', '.cache', 'tmp', 'temp', 'coverage',
            '.nyc_output', '.pytest_cache', '.snapshots'
        ];
        if (excludedDirs.includes(baseName)) {
            return true;
        }

        return this.excludePatterns.some(pattern => {
            const regex = this.globToRegex(pattern);
            const matches = regex.test(normalizedPath);
            return matches;
        });
    }

    private shouldIncludeFile(filePath: string): boolean {
        const normalizedPath = path.normalize(filePath).replace(/\\/g, '/');

        return this.includePatterns.some(pattern => {
            const regex = this.globToRegex(pattern);
            return regex.test(normalizedPath);
        });
    }

    private globToRegex(glob: string): RegExp {
        const escaped = glob
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '___DOUBLESTAR___')
            .replace(/\*/g, '[^/]*')
            .replace(/___DOUBLESTAR___/g, '.*')
            .replace(/\?/g, '[^/]');

        return new RegExp(`^${escaped}$`);
    }
} 