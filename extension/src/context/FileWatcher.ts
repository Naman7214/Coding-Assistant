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
    useVSCodeWatcher: boolean;
    useChokidarWatcher: boolean;
    watchGlob: string;
    excludePattern: string;
    projectStructureChangeDebounce: number;
    fileChangeDebounce: number;
    watchOptions: {
        recursive: boolean;
        followSymlinks: boolean;
        ignorePermissionErrors: boolean;
    };
    watchCreatedFiles: boolean;
    watchDeletedFiles: boolean;
    watchModifiedFiles: boolean;
    watchRenamedFiles: boolean;
}

export class FileWatcher extends EventEmitter {
    private config: FileWatcherConfig;
    private workspacePath: string;
    private outputChannel: vscode.OutputChannel;
    private fsWatcher: vscode.FileSystemWatcher | null = null;
    private chokidarWatcher: any | null = null;
    private watchedPaths: Set<string> = new Set();
    private isWatching: boolean = false;
    private events: FileChangeEvent[] = [];
    private changeDebounceTimer: NodeJS.Timeout | null = null;
    private projectStructureChangeDebounceTimer: NodeJS.Timeout | null = null;
    private disposables: vscode.Disposable[] = [];
    private stats = {
        changes: 0,
        additions: 0,
        deletions: 0,
        renames: 0,
        projectStructureChanges: 0,
        errorCount: 0
    };

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
            watchGlob: "**/*",
            excludePattern: "**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.cache/**",
            projectStructureChangeDebounce: 500,
            fileChangeDebounce: 300,
            useVSCodeWatcher: true,
            useChokidarWatcher: false,
            watchOptions: {
                recursive: true,
                followSymlinks: false,
                ignorePermissionErrors: true
            },
            watchCreatedFiles: true,
            watchDeletedFiles: true,
            watchModifiedFiles: true,
            watchRenamedFiles: true,
            ...config
        };

        this.outputChannel.appendLine(`[FileWatcher] Initialized for workspace: ${workspacePath}`);
    }

    /**
     * Start watching for file changes
     */
    async startWatching(): Promise<boolean> {
        if (this.isWatching) {
            return true;
        }

        try {
            this.outputChannel.appendLine('[FileWatcher] Starting file watching...');

            // Use VS Code's FileSystemWatcher if enabled
            if (this.config.useVSCodeWatcher) {
                await this.startVSCodeWatcher();
            }

            // Use chokidar watcher if enabled (can be used alongside VS Code watcher)
            if (this.config.useChokidarWatcher) {
                await this.startChokidarWatcher();
            }

            // Listen for workspace folder changes
            this.disposables.push(
                vscode.workspace.onDidChangeWorkspaceFolders(this.handleWorkspaceFoldersChanged.bind(this))
            );

            // Listen for configuration changes
            this.disposables.push(
                vscode.workspace.onDidChangeConfiguration(this.handleConfigurationChanged.bind(this))
            );

            this.isWatching = true;
            this.outputChannel.appendLine('[FileWatcher] File watching started successfully');
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`[FileWatcher] Failed to start watching: ${error}`);
            this.stats.errorCount++;
            return false;
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
        if (this.fsWatcher) {
            this.fsWatcher.dispose();
            this.fsWatcher = null;
        }

        // Close Chokidar watcher
        if (this.chokidarWatcher) {
            await this.chokidarWatcher.close();
            this.chokidarWatcher = null;
        }

        // Dispose all VS Code disposables
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];

        this.isWatching = false;
        this.watchedPaths.clear();

        this.outputChannel.appendLine('[FileWatcher] File watching stopped');
        this.emit('watchingStopped');
    }

    /**
     * Add specific file or directory to watch list
     */
    async addToWatch(filePath: string): Promise<void> {
        if (!this.isWatching || this.watchedPaths.has(filePath)) {
            return;
        }

        if (this.shouldIgnorePath(filePath)) {
            return;
        }

        this.watchedPaths.add(filePath);

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
        if (!this.watchedPaths.has(filePath)) {
            return;
        }

        this.watchedPaths.delete(filePath);

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
        return Array.from(this.watchedPaths);
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
        this.fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        // File created
        this.disposables.push(
            this.fsWatcher.onDidCreate(uri => {
                this.handleFileEvent('created', uri.fsPath);
            })
        );

        // File modified
        this.disposables.push(
            this.fsWatcher.onDidChange(uri => {
                this.handleFileEvent('modified', uri.fsPath);
            })
        );

        // File deleted
        this.disposables.push(
            this.fsWatcher.onDidDelete(uri => {
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
            ignored: this.config.excludePattern,
            persistent: true,
            ignoreInitial: true,
            followSymlinks: this.config.watchOptions.followSymlinks,
            depth: 999,
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
     * Handle workspace folder changes
     */
    private handleWorkspaceFoldersChanged(event: vscode.WorkspaceFoldersChangeEvent): void {
        this.outputChannel.appendLine('[FileWatcher] Workspace folders changed');

        // Handle added folders
        for (const folder of event.added) {
            this.outputChannel.appendLine(`[FileWatcher] Workspace folder added: ${folder.uri.fsPath}`);
        }

        // Handle removed folders
        for (const folder of event.removed) {
            this.outputChannel.appendLine(`[FileWatcher] Workspace folder removed: ${folder.uri.fsPath}`);
        }

        // Emit a structure change event with a special case for workspace changes
        this.emitStructuralChange('created', '');
    }

    /**
     * Handle configuration changes
     */
    private handleConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
        // Check if our relevant configuration changed
        if (event.affectsConfiguration('files.watcherExclude') ||
            event.affectsConfiguration('files.exclude')) {
            this.outputChannel.appendLine('[FileWatcher] File watching configuration changed');

            // Consider restarting watchers with new configuration
            if (this.isWatching) {
                this.stopWatching().then(() => this.startWatching());
            }
        }
    }

    /**
     * Emit a project structure change event for file/directory operations
     */
    private emitProjectStructureChangeEvent(type: 'created' | 'modified' | 'deleted' | 'renamed', relativePath: string): void {
        this.emitStructuralChange(type, relativePath);
    }

    /**
     * Common method to emit structural changes in the project
     */
    private emitStructuralChange(type: 'created' | 'modified' | 'deleted' | 'renamed', relativePath: string): void {
        const event: FileChangeEvent = {
            type,
            filePath: path.join(this.workspacePath, relativePath),
            relativePath,
            timestamp: Date.now()
        };

        if (this.projectStructureChangeDebounceTimer) {
            clearTimeout(this.projectStructureChangeDebounceTimer);
        }

        this.projectStructureChangeDebounceTimer = setTimeout(() => {
            this.emit('projectStructureChange', event);
            this.stats.projectStructureChanges++;
            this.outputChannel.appendLine(`[FileWatcher] Project structure change: ${type} - ${relativePath}`);
        }, this.config.projectStructureChangeDebounce);
    }

    /**
     * Handle file change events with debouncing
     */
    private handleFileEvent(type: FileChangeEvent['type'], filePath: string): void {
        if (!this.config.enabled || this.shouldIgnorePath(filePath)) {
            return;
        }

        const relativePath = path.relative(this.workspacePath, filePath);

        // Skip if file is in an ignored pattern
        if (this.shouldIgnorePath(filePath)) {
            return;
        }

        // Create event data
        const event: FileChangeEvent = {
            type,
            filePath,
            relativePath,
            timestamp: Date.now()
        };

        // Check if event affects project structure (creation, deletion, or renaming)
        const affectsProjectStructure =
            type === 'created' ||
            type === 'deleted' ||
            type === 'renamed';

        // Get file key for debouncing (can be a directory)
        const fileKey = filePath;

        // Cancel existing timer for the same file
        if (this.changeDebounceTimer) {
            clearTimeout(this.changeDebounceTimer);
        }

        // Store the event
        this.events.push(event);

        // Set up debounce timer
        this.changeDebounceTimer = setTimeout(() => {
            const pendingEvents = this.events.filter(e => e.filePath === filePath);
            if (pendingEvents.length > 0) {
                // Emit the file change event
                this.emit('fileChange', pendingEvents[0]);

                // Emit additional event for project structure changes
                if (affectsProjectStructure) {
                    this.emit('projectStructureChange', pendingEvents[0]);
                    this.outputChannel.appendLine(`[FileWatcher] Project structure change detected: ${pendingEvents[0].type} - ${pendingEvents[0].relativePath}`);
                }

                this.debug(`File ${pendingEvents[0].type}: ${pendingEvents[0].relativePath}`);

                // Remove from pending events
                this.events = this.events.filter(e => e.filePath !== filePath);
            }
        }, this.config.fileChangeDebounce);

        // Store the timer
        if (this.changeDebounceTimer) {
            this.changeDebounceTimer = this.changeDebounceTimer;
        }
    }

    /**
     * Check if path should be ignored
     */
    private shouldIgnorePath(filePath: string): boolean {
        const relativePath = path.relative(this.workspacePath, filePath);

        // Check if it's a hidden file and we're not watching them
        if (!this.config.watchOptions.followSymlinks && path.basename(filePath).startsWith('.')) {
            return true;
        }

        // Check against ignore patterns
        for (const pattern of this.config.excludePattern.split(',')) {
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
        if (this.changeDebounceTimer) {
            clearTimeout(this.changeDebounceTimer);
            this.changeDebounceTimer = null;
        }
        this.events = [];
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
        if (this.config.excludePattern.includes('debug')) {
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
            watchedFilesCount: this.watchedPaths.size,
            pendingEventsCount: this.events.length,
            activeTimersCount: this.changeDebounceTimer ? 1 : 0,
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