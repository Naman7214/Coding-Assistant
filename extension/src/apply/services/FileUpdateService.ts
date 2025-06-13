import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { IFileUpdateService } from '../types/apply.types';

export class FileUpdateService implements IFileUpdateService {
    private backupDir: string;
    private context: vscode.ExtensionContext | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;
    private readonly maxBackupAge: number = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    private readonly cleanupInterval: number = 60 * 60 * 1000; // 1 hour cleanup interval

    constructor(context?: vscode.ExtensionContext) {
        this.context = context || null;
        // Use VSCode's hidden storage instead of workspace-visible folder
        this.backupDir = this.getBackupDirectory();
        this.ensureBackupDirectory();
        this.startPeriodicCleanup();
    }

    /**
     * Read file content from the file system
     */
    async readFileContent(filePath: string): Promise<string> {
        if (!this.validateFilePath(filePath)) {
            throw new Error(`Invalid file path: ${filePath}`);
        }

        try {
            const uri = vscode.Uri.file(filePath);

            // First try to get content from open document in VSCode
            const openDocument = vscode.workspace.textDocuments.find(
                doc => doc.uri.fsPath === uri.fsPath
            );

            if (openDocument && !openDocument.isClosed) {
                return openDocument.getText();
            }

            // Otherwise read from file system
            const content = await fs.readFile(filePath, 'utf-8');
            return content;

        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to read file ${filePath}: ${error.message}`);
            }
            throw new Error(`Failed to read file ${filePath}: Unknown error`);
        }
    }

    /**
     * Write file content using VSCode's workspace API
     */
    async writeFileContent(filePath: string, content: string): Promise<void> {
        if (!this.validateFilePath(filePath)) {
            throw new Error(`Invalid file path: ${filePath}`);
        }

        try {
            const uri = vscode.Uri.file(filePath);

            // Check if file is open in editor
            const openDocument = vscode.workspace.textDocuments.find(
                doc => doc.uri.fsPath === uri.fsPath
            );

            if (openDocument && !openDocument.isClosed) {
                // Use VSCode's WorkspaceEdit for open documents
                await this.updateOpenDocument(openDocument, content);
            } else {
                // Use file system for closed documents
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            }

        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to write file ${filePath}: ${error.message}`);
            }
            throw new Error(`Failed to write file ${filePath}: Unknown error`);
        }
    }

    /**
     * Update an open document using WorkspaceEdit
     */
    private async updateOpenDocument(document: vscode.TextDocument, newContent: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();

        // Replace entire document content
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );

        edit.replace(document.uri, fullRange, newContent);

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            throw new Error('Failed to apply workspace edit');
        }
    }

    /**
     * Create a backup of the file before modification
     */
    async createBackup(filePath: string): Promise<string> {
        if (!this.validateFilePath(filePath)) {
            throw new Error(`Invalid file path: ${filePath}`);
        }

        try {
            const content = await this.readFileContent(filePath);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = path.basename(filePath);
            const backupFileName = `${fileName}.${timestamp}.backup`;
            const backupPath = path.join(this.backupDir, backupFileName);

            await fs.writeFile(backupPath, content, 'utf-8');

            // Clean old backups when creating a new one
            this.cleanOldBackups().catch(error => {
                console.warn('Failed to clean old backups:', error);
            });

            return backupPath;

        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to create backup for ${filePath}: ${error.message}`);
            }
            throw new Error(`Failed to create backup for ${filePath}: Unknown error`);
        }
    }

    /**
     * Restore file from backup
     */
    async restoreFromBackup(filePath: string, backupPath: string): Promise<void> {
        if (!this.validateFilePath(filePath)) {
            throw new Error('Invalid file paths provided for restore');
        }

        try {
            const backupContent = await fs.readFile(backupPath, 'utf-8');
            await this.writeFileContent(filePath, backupContent);

            // Clean up backup file after successful restore
            await fs.unlink(backupPath);

        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to restore from backup: ${error.message}`);
            }
            throw new Error('Failed to restore from backup: Unknown error');
        }
    }

    /**
     * Validate file path for security and correctness
     */
    validateFilePath(filePath: string): boolean {
        if (!filePath || typeof filePath !== 'string') {
            return false;
        }

        // Check if path is absolute
        if (!path.isAbsolute(filePath)) {
            return false;
        }

        // Check for path traversal attempts
        const normalizedPath = path.normalize(filePath);
        if (normalizedPath !== filePath) {
            return false;
        }

        // Check if file exists within workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const isInWorkspace = workspaceFolders.some(folder => {
            const workspaceRoot = folder.uri.fsPath;
            return normalizedPath.startsWith(workspaceRoot);
        });

        return isInWorkspace;
    }

    /**
     * Check if file exists
     */
    async fileExists(filePath: string): Promise<boolean> {
        try {
            const uri = vscode.Uri.file(filePath);
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get file stats
     */
    async getFileStats(filePath: string): Promise<vscode.FileStat> {
        const uri = vscode.Uri.file(filePath);
        return await vscode.workspace.fs.stat(uri);
    }

    /**
     * Watch file for changes
     */
    watchFile(filePath: string, callback: (uri: vscode.Uri) => void): vscode.Disposable {
        const uri = vscode.Uri.file(filePath);

        return vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.fsPath === uri.fsPath) {
                callback(uri);
            }
        });
    }

    /**
     * Get backup directory path using VSCode's hidden storage
     */
    private getBackupDirectory(): string {
        // Priority 1: Use extension's workspace storage (hidden from user)
        if (this.context?.storageUri) {
            return path.join(this.context.storageUri.fsPath, 'apply-backups');
        }

        // Priority 2: Use extension's global storage (hidden from user)
        if (this.context?.globalStorageUri) {
            return path.join(this.context.globalStorageUri.fsPath, 'apply-backups');
        }

        // Priority 3: Create hidden folder in workspace storage directory
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            // Use workspace storage path which is typically hidden
            const workspaceId = this.generateWorkspaceId(workspaceFolders[0].uri.fsPath);
            return path.join(
                require('os').homedir(),
                '.vscode-extensions',
                'apply-backups',
                workspaceId
            );
        }

        // Fallback: OS temp directory (completely hidden)
        const os = require('os');
        return path.join(os.tmpdir(), 'vscode-apply-backups');
    }

    /**
     * Generate a unique workspace ID for backup storage
     */
    private generateWorkspaceId(workspacePath: string): string {
        // Create a hash-like identifier from workspace path
        let hash = 0;
        for (let i = 0; i < workspacePath.length; i++) {
            const char = workspacePath.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36) + '_' + path.basename(workspacePath).replace(/[^a-zA-Z0-9]/g, '_');
    }

    /**
     * Ensure backup directory exists
     */
    private async ensureBackupDirectory(): Promise<void> {
        try {
            await fs.mkdir(this.backupDir, { recursive: true });
        } catch (error) {
            console.warn('Failed to create backup directory:', error);
        }
    }

    /**
     * Start periodic cleanup of old backups
     */
    private startPeriodicCleanup(): void {
        // Clean immediately on startup
        this.cleanOldBackups().catch(error => {
            console.warn('Failed initial backup cleanup:', error);
        });

        // Set up periodic cleanup
        this.cleanupTimer = setInterval(() => {
            this.cleanOldBackups().catch(error => {
                console.warn('Failed periodic backup cleanup:', error);
            });
        }, this.cleanupInterval);
    }

    /**
     * Clean old backup files based on age and count
     */
    async cleanOldBackups(): Promise<void> {
        try {
            const files = await fs.readdir(this.backupDir);
            const now = Date.now();
            const backupFiles: Array<{ name: string; path: string; mtime: number }> = [];

            // Get backup file info
            for (const file of files) {
                if (file.endsWith('.backup')) {
                    const filePath = path.join(this.backupDir, file);
                    try {
                        const stats = await fs.stat(filePath);
                        backupFiles.push({
                            name: file,
                            path: filePath,
                            mtime: stats.mtime.getTime()
                        });
                    } catch (error) {
                        // File might have been deleted, skip
                        continue;
                    }
                }
            }

            // Remove files older than maxBackupAge
            const filesToDelete = backupFiles.filter(file =>
                now - file.mtime > this.maxBackupAge
            );

            // Also keep only the latest 50 backups per workspace to prevent unlimited growth
            const maxBackupCount = 50;
            if (backupFiles.length > maxBackupCount) {
                const sortedFiles = backupFiles.sort((a, b) => b.mtime - a.mtime);
                const oldFiles = sortedFiles.slice(maxBackupCount);
                filesToDelete.push(...oldFiles.filter(f => !filesToDelete.includes(f)));
            }

            // Delete old files
            for (const file of filesToDelete) {
                try {
                    await fs.unlink(file.path);
                } catch (error) {
                    console.warn(`Failed to delete backup file ${file.name}:`, error);
                }
            }

            if (filesToDelete.length > 0) {
                console.log(`Cleaned ${filesToDelete.length} old backup files`);
            }

        } catch (error) {
            console.warn('Failed to clean old backups:', error);
        }
    }

    /**
     * Get all backup files for a specific file
     */
    async getBackupsForFile(filePath: string): Promise<string[]> {
        try {
            const fileName = path.basename(filePath);
            const files = await fs.readdir(this.backupDir);

            return files
                .filter(file => file.startsWith(fileName) && file.endsWith('.backup'))
                .map(file => path.join(this.backupDir, file))
                .sort(); // Sort by name (which includes timestamp)

        } catch {
            return [];
        }
    }

    /**
     * Get backup storage statistics
     */
    async getBackupStats(): Promise<{
        backupDir: string;
        totalBackups: number;
        totalSize: number;
        oldestBackup: Date | null;
        newestBackup: Date | null;
    }> {
        try {
            const files = await fs.readdir(this.backupDir);
            const backupFiles = files.filter(file => file.endsWith('.backup'));

            let totalSize = 0;
            let oldestTime = Infinity;
            let newestTime = 0;

            for (const file of backupFiles) {
                try {
                    const filePath = path.join(this.backupDir, file);
                    const stats = await fs.stat(filePath);
                    totalSize += stats.size;
                    oldestTime = Math.min(oldestTime, stats.mtime.getTime());
                    newestTime = Math.max(newestTime, stats.mtime.getTime());
                } catch {
                    // Skip files that can't be read
                }
            }

            return {
                backupDir: this.backupDir,
                totalBackups: backupFiles.length,
                totalSize,
                oldestBackup: oldestTime === Infinity ? null : new Date(oldestTime),
                newestBackup: newestTime === 0 ? null : new Date(newestTime)
            };
        } catch {
            return {
                backupDir: this.backupDir,
                totalBackups: 0,
                totalSize: 0,
                oldestBackup: null,
                newestBackup: null
            };
        }
    }

    /**
     * Dispose resources and clean up
     */
    dispose(): void {
        // Stop periodic cleanup
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // Final cleanup on dispose
        this.cleanOldBackups().catch(error => {
            console.warn('Failed to clean backups on dispose:', error);
        });
    }

    /**
     * Create a file and its parent directories if they do not exist
     */
    async createFileWithDirs(filePath: string): Promise<void> {
        const dir = path.dirname(filePath);
        try {
            // Create parent directories if they do not exist
            await fs.mkdir(dir, { recursive: true });
            // Only create the file if it does not exist
            const exists = await this.fileExists(filePath);
            if (!exists) {
                await fs.writeFile(filePath, '', 'utf-8');
            }
        } catch (error) {
            throw new Error(`Failed to create file or directories for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} 