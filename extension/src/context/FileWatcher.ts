import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as vscode from 'vscode';

export interface FileChangeEvent {
    type: 'created' | 'modified' | 'deleted' | 'renamed';
    filePath: string;
    relativePath: string;
    timestamp: number;
    stats?: vscode.FileStat;
    oldPath?: string; // For renamed files
}

export interface FileWatcherConfig {
    enabled: boolean;
    useVSCodeWatcher: boolean;    // Use VS Code's built-in watcher
    useChokidar: boolean;         // Use chokidar for more advanced watching
    ignorePatterns: string[];     // Patterns to ignore
    debounceDelay: number;        // Milliseconds to debounce events
    maxDepth: number;             // Maximum directory depth to watch
    followSymlinks: boolean;      // Whether to follow symbolic links
    watchHiddenFiles: boolean;    // Whether to watch hidden files
}

export class FileWatcher extends EventEmitter {
    private config: FileWatcherConfig;
    private outputChannel: vscode.OutputChannel;
    private vsCodeWatcher?: vscode.FileSystemWatcher;
    private chokidarWatcher?: ReturnType<typeof chokidar.watch>;
    private workspacePath: string;
    private isWatching: boolean = false;
    private pendingEvents: Map<string, FileChangeEvent> = new Map();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private watchedFiles: Set<string> = new Set();
    private disposables: vscode.Disposable[] = [];

    constructor(
        workspacePath: string,
        outputChannel: vscode.OutputChannel,
        config?: Partial<FileWatcherConfig>
    ) {
        super();

        this.workspacePath = workspacePath;
        this.outputChannel = outputChannel;

        // Default configuration
        this.config = {
            enabled: true,
            useVSCodeWatcher: true,
            useChokidar: true,
            ignorePatterns: [
                '**/node_modules/**',
                '**/.git/**',
                '**/.vscode/**',
                '**/dist/**',
                '**/build/**',
                '**/*.log',
                '**/tmp/**',
                '**/.DS_Store',
                '**/Thumbs.db'
            ],
            debounceDelay: 100,
            maxDepth: 10,
            followSymlinks: false,
            watchHiddenFiles: false,
            ...config
        };

        this.outputChannel.appendLine(`[FileWatcher] Initialized for workspace: ${workspacePath}`);
    }

    /**
     * Start watching files in the workspace
     */
    async startWatching(): Promise<void> {
        if (!this.config.enabled || this.isWatching) {
            return;
        }

        try {
            this.outputChannel.appendLine('[FileWatcher] Starting file watching...');

            // Start VS Code's built-in watcher
            if (this.config.useVSCodeWatcher) {
                await this.startVSCodeWatcher();
            }

            // Start Chokidar watcher for more advanced features
            if (this.config.useChokidar) {
                await this.startChokidarWatcher();
            }

            // Watch for workspace folder changes
            this.watchWorkspaceChanges();

            this.isWatching = true;
            this.outputChannel.appendLine('[FileWatcher] File watching started successfully');

            this.emit('watchingStarted');

        } catch (error) {
            this.outputChannel.appendLine(`[FileWatcher] Failed to start watching: ${error}`);
            throw error;
        }
    }

    /**
     * Stop watching files
     */
    async stopWatching(): Promise<void> {
        if (!this.isWatching) {
            return;
        }

        this.outputChannel.appendLine('[FileWatcher] Stopping file watching...');

        // Clear pending events and timers
        this.clearPendingEvents();

        // Dispose VS Code watcher
        if (this.vsCodeWatcher) {
            this.vsCodeWatcher.dispose();
            this.vsCodeWatcher = undefined;
        }

        // Close Chokidar watcher
        if (this.chokidarWatcher) {
            await this.chokidarWatcher.close();
            this.chokidarWatcher = undefined;
        }

        // Dispose all VS Code disposables
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];

        this.isWatching = false;
        this.watchedFiles.clear();

        this.outputChannel.appendLine('[FileWatcher] File watching stopped');
        this.emit('watchingStopped');
    }

    /**
     * Add specific file or directory to watch list
     */
    async addToWatch(filePath: string): Promise<void> {
        if (!this.isWatching || this.watchedFiles.has(filePath)) {
            return;
        }

        if (this.shouldIgnorePath(filePath)) {
            return;
        }

        this.watchedFiles.add(filePath);

        // Add to chokidar watcher if available
        if (this.chokidarWatcher) {
            this.chokidarWatcher.add(filePath);
        }

        this.outputChannel.appendLine(`[FileWatcher] Added to watch list: ${filePath}`);
    }

    /**
     * Remove file or directory from watch list
     */
    async removeFromWatch(filePath: string): Promise<void> {
        if (!this.watchedFiles.has(filePath)) {
            return;
        }

        this.watchedFiles.delete(filePath);

        // Remove from chokidar watcher if available
        if (this.chokidarWatcher) {
            this.chokidarWatcher.unwatch(filePath);
        }

        this.outputChannel.appendLine(`[FileWatcher] Removed from watch list: ${filePath}`);
    }

    /**
     * Get list of currently watched files
     */
    getWatchedFiles(): string[] {
        return Array.from(this.watchedFiles);
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<FileWatcherConfig>): void {
        this.config = { ...this.config, ...newConfig };
        this.outputChannel.appendLine('[FileWatcher] Configuration updated');

        // Restart watching if configuration changes affect watching
        if (this.isWatching) {
            this.restartWatching();
        }
    }

    /**
     * Start VS Code's built-in file watcher
     */
    private async startVSCodeWatcher(): Promise<void> {
        const pattern = new vscode.RelativePattern(this.workspacePath, '**/*');
        this.vsCodeWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        // File created
        this.disposables.push(
            this.vsCodeWatcher.onDidCreate(uri => {
                this.handleFileEvent('created', uri.fsPath);
            })
        );

        // File modified
        this.disposables.push(
            this.vsCodeWatcher.onDidChange(uri => {
                this.handleFileEvent('modified', uri.fsPath);
            })
        );

        // File deleted
        this.disposables.push(
            this.vsCodeWatcher.onDidDelete(uri => {
                this.handleFileEvent('deleted', uri.fsPath);
            })
        );

        this.outputChannel.appendLine('[FileWatcher] VS Code watcher started');
    }

    /**
     * Start Chokidar watcher for advanced file watching
     */
    private async startChokidarWatcher(): Promise<void> {
        const chokidarOptions = {
            ignored: this.config.ignorePatterns,
            persistent: true,
            ignoreInitial: true,
            followSymlinks: this.config.followSymlinks,
            depth: this.config.maxDepth,
            awaitWriteFinish: {
                stabilityThreshold: 100,
                pollInterval: 100
            }
        };

        this.chokidarWatcher = chokidar.watch(this.workspacePath, chokidarOptions);

        // Set up event handlers
        this.chokidarWatcher
            .on('add', (filePath: string) => {
                this.handleFileEvent('created', filePath);
            })
            .on('change', (filePath: string) => {
                this.handleFileEvent('modified', filePath);
            })
            .on('unlink', (filePath: string) => {
                this.handleFileEvent('deleted', filePath);
            })
            .on('addDir', (dirPath: string) => {
                this.handleFileEvent('created', dirPath);
            })
            .on('unlinkDir', (dirPath: string) => {
                this.handleFileEvent('deleted', dirPath);
            })
            .on('ready', () => {
                this.outputChannel.appendLine('[FileWatcher] Chokidar watcher ready');
            })
            .on('error', (err: unknown) => {
                const error = err instanceof Error ? err : new Error(String(err));
                this.outputChannel.appendLine(`[FileWatcher] Chokidar error: ${error.message}`);
                this.emit('error', error);
            });

        this.outputChannel.appendLine('[FileWatcher] Chokidar watcher started');
    }

    /**
     * Watch for workspace folder changes
     */
    private watchWorkspaceChanges(): void {
        // Watch for workspace folder changes
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(event => {
                this.outputChannel.appendLine('[FileWatcher] Workspace folders changed');

                event.added.forEach(folder => {
                    this.outputChannel.appendLine(`[FileWatcher] Workspace folder added: ${folder.uri.fsPath}`);
                });

                event.removed.forEach(folder => {
                    this.outputChannel.appendLine(`[FileWatcher] Workspace folder removed: ${folder.uri.fsPath}`);
                });

                this.emit('workspaceChanged', event);
            })
        );

        // Watch for configuration changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('files.watcherExclude') ||
                    event.affectsConfiguration('search.exclude')) {
                    this.outputChannel.appendLine('[FileWatcher] File watching configuration changed');
                    this.emit('configurationChanged', event);
                }
            })
        );
    }

    /**
     * Handle file change events with debouncing
     */
    private handleFileEvent(type: FileChangeEvent['type'], filePath: string): void {
        if (this.shouldIgnorePath(filePath)) {
            return;
        }

        const relativePath = path.relative(this.workspacePath, filePath);

        // Clear existing timer for this file
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Create file change event
        const event: FileChangeEvent = {
            type,
            filePath,
            relativePath,
            timestamp: Date.now()
        };

        // Debounce the event
        const timer = setTimeout(async () => {
            // Get file stats if file exists
            if (type !== 'deleted') {
                try {
                    event.stats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                } catch {
                    // File might have been deleted between event and stat
                }
            }

            // Remove from pending events and timers
            this.pendingEvents.delete(filePath);
            this.debounceTimers.delete(filePath);

            // Emit the event
            this.emit('fileChanged', event);

            this.debug(`File ${type}: ${relativePath}`);

        }, this.config.debounceDelay);

        // Store timer and event
        this.debounceTimers.set(filePath, timer);
        this.pendingEvents.set(filePath, event);
    }

    /**
     * Check if path should be ignored
     */
    private shouldIgnorePath(filePath: string): boolean {
        const relativePath = path.relative(this.workspacePath, filePath);

        // Check if it's a hidden file and we're not watching them
        if (!this.config.watchHiddenFiles && path.basename(filePath).startsWith('.')) {
            return true;
        }

        // Check against ignore patterns
        for (const pattern of this.config.ignorePatterns) {
            if (this.matchesGlob(relativePath, pattern)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Simple glob pattern matching
     */
    private matchesGlob(text: string, pattern: string): boolean {
        const regexPattern = pattern
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]');

        const regex = new RegExp('^' + regexPattern + '$');
        return regex.test(text);
    }

    /**
     * Clear all pending events and timers
     */
    private clearPendingEvents(): void {
        // Clear all debounce timers
        this.debounceTimers.forEach((timer) => {
            clearTimeout(timer);
        });
        this.debounceTimers.clear();
        this.pendingEvents.clear();
    }

    /**
     * Restart watching (used when configuration changes)
     */
    private async restartWatching(): Promise<void> {
        await this.stopWatching();
        await this.startWatching();
    }

    /**
     * Debug logging
     */
    private debug(message: string): void {
        // Only log if debugging is enabled
        if (this.config.ignorePatterns.includes('debug')) {
            this.outputChannel.appendLine(`[FileWatcher] DEBUG: ${message}`);
        }
    }

    /**
     * Get watcher statistics
     */
    getStats(): {
        isWatching: boolean;
        watchedFilesCount: number;
        pendingEventsCount: number;
        activeTimersCount: number;
        workspacePath: string;
        config: FileWatcherConfig;
    } {
        return {
            isWatching: this.isWatching,
            watchedFilesCount: this.watchedFiles.size,
            pendingEventsCount: this.pendingEvents.size,
            activeTimersCount: this.debounceTimers.size,
            workspacePath: this.workspacePath,
            config: { ...this.config }
        };
    }

    /**
     * Dispose of the file watcher
     */
    dispose(): void {
        this.stopWatching();
        this.removeAllListeners();
        this.outputChannel.appendLine('[FileWatcher] Disposed');
    }
} 