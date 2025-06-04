import * as vscode from 'vscode';
import { CacheManager } from '../../storage/CacheManager';
import { CollectorConfig, CollectorMetadata, IContextCollector } from '../../types/collectors';
import { ContextData } from '../../types/context';

export abstract class BaseCollector implements IContextCollector {
    public readonly name: string;
    public readonly type: string;
    public readonly weight: number;

    protected outputChannel: vscode.OutputChannel;
    protected cacheManager: CacheManager;
    protected config: CollectorConfig;
    protected workspaceId: string;
    protected isDisposed: boolean = false;

    // Performance tracking
    private collectCount: number = 0;
    private totalDuration: number = 0;
    private errorCount: number = 0;
    private lastError?: string;

    constructor(
        name: string,
        type: string,
        weight: number,
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string,
        config?: Partial<CollectorConfig>
    ) {
        this.name = name;
        this.type = type;
        this.weight = weight;
        this.outputChannel = outputChannel;
        this.cacheManager = cacheManager;
        this.workspaceId = workspaceId;

        // Default configuration
        this.config = {
            enabled: true,
            weight: weight,
            options: {},
            cacheTimeout: 300, // 5 minutes default
            maxRetries: 3,
            ...config
        };

        this.outputChannel.appendLine(`[${this.name}] Collector initialized`);
    }

    abstract canCollect(): Promise<boolean>;
    abstract collect(): Promise<ContextData | null>;
    abstract getMetadata(): CollectorMetadata;

    /**
     * Collect with caching, error handling, and performance tracking
     */
    async collectSafely(): Promise<ContextData | null> {
        if (!this.config.enabled || this.isDisposed) {
            return null;
        }

        const startTime = Date.now();
        let attempt = 0;
        let lastError: Error | null = null;

        while (attempt < this.config.maxRetries) {
            try {
                // Check cache first
                const cacheKey = this.generateCacheKey();
                if (this.shouldUseCache()) {
                    const cached = await this.cacheManager.getContextData(
                        this.workspaceId,
                        this.type,
                        cacheKey
                    );

                    if (cached) {
                        this.outputChannel.appendLine(`[${this.name}] Retrieved from cache`);
                        return cached;
                    }
                }

                // Check if collection is possible
                if (!(await this.canCollect())) {
                    this.outputChannel.appendLine(`[${this.name}] Cannot collect at this time`);
                    return null;
                }

                // Perform collection
                const data = await this.collect();

                if (data) {
                    // Store in cache if successful
                    if (this.shouldUseCache()) {
                        await this.cacheManager.storeContextData(
                            this.workspaceId,
                            this.type,
                            data,
                            this.config.cacheTimeout
                        );
                    }

                    // Update performance metrics
                    this.updatePerformanceMetrics(Date.now() - startTime, true);

                    this.outputChannel.appendLine(
                        `[${this.name}] Collected successfully (${Date.now() - startTime}ms)`
                    );

                    return data;
                }

                return null;

            } catch (error) {
                lastError = error as Error;
                attempt++;
                this.errorCount++;
                this.lastError = error instanceof Error ? error.message : String(error);

                this.outputChannel.appendLine(
                    `[${this.name}] Collection failed (attempt ${attempt}/${this.config.maxRetries}): ${error}`
                );

                if (attempt < this.config.maxRetries) {
                    // Wait before retry with exponential backoff
                    await this.sleep(Math.pow(2, attempt) * 100);
                }
            }
        }

        // Update performance metrics for failure
        this.updatePerformanceMetrics(Date.now() - startTime, false);

        this.outputChannel.appendLine(
            `[${this.name}] Collection failed after ${this.config.maxRetries} attempts: ${lastError?.message}`
        );

        return null;
    }

    /**
     * Update collector configuration
     */
    updateConfig(newConfig: Partial<CollectorConfig>): void {
        this.config = { ...this.config, ...newConfig };
        this.outputChannel.appendLine(`[${this.name}] Configuration updated`);
    }

    /**
     * Get collector configuration
     */
    getConfig(): CollectorConfig {
        return { ...this.config };
    }

    /**
     * Get performance statistics
     */
    getPerformanceStats(): {
        collectCount: number;
        averageDuration: number;
        errorCount: number;
        errorRate: number;
        lastError?: string;
    } {
        return {
            collectCount: this.collectCount,
            averageDuration: this.collectCount > 0 ? this.totalDuration / this.collectCount : 0,
            errorCount: this.errorCount,
            errorRate: this.collectCount > 0 ? this.errorCount / this.collectCount : 0,
            lastError: this.lastError
        };
    }

    /**
     * Reset performance statistics
     */
    resetStats(): void {
        this.collectCount = 0;
        this.totalDuration = 0;
        this.errorCount = 0;
        this.lastError = undefined;
    }

    /**
     * Check if collector should use caching
     */
    protected shouldUseCache(): boolean {
        return this.getMetadata().cacheable && this.config.cacheTimeout > 0;
    }

    /**
     * Generate cache key for this collector
     */
    protected generateCacheKey(): string {
        // Base implementation - can be overridden by specific collectors
        return `${this.name}_${this.type}`;
    }

    /**
     * Get workspace folder
     */
    protected getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
    }

    /**
     * Get workspace path
     */
    protected getWorkspacePath(): string {
        return this.getWorkspaceFolder()?.uri.fsPath || '';
    }

    /**
     * Get relative path from workspace root
     */
    protected getRelativePath(fullPath: string): string {
        // Safety check for undefined/null/empty paths
        if (!fullPath || typeof fullPath !== 'string') {
            this.debug(`Invalid fullPath in getRelativePath: ${fullPath}`);
            return '';
        }

        const workspacePath = this.getWorkspacePath();
        if (workspacePath && fullPath.startsWith(workspacePath)) {
            const relativePath = fullPath.substring(workspacePath.length + 1);
            return relativePath || '';
        }
        return fullPath;
    }

    /**
     * Create context data with standard structure
     */
    protected createContextData(
        id: string,
        data: any,
        metadata?: Record<string, any>
    ): ContextData {
        return {
            id,
            type: this.type,
            timestamp: Date.now(),
            weight: this.weight,
            data,
            metadata: {
                collector: this.name,
                workspaceId: this.workspaceId,
                ...metadata
            }
        };
    }

    /**
     * Generate unique ID for context data
     */
    protected generateId(): string {
        return `${this.name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Sleep for specified milliseconds
     */
    protected sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Log debug information
     */
    protected debug(message: string, data?: any): void {
        if (this.config.options.debug) {
            this.outputChannel.appendLine(`[${this.name}] DEBUG: ${message}`);
            if (data) {
                this.outputChannel.appendLine(`[${this.name}] DEBUG DATA: ${JSON.stringify(data, null, 2)}`);
            }
        }
    }

    /**
     * Log warning
     */
    protected warn(message: string): void {
        this.outputChannel.appendLine(`[${this.name}] WARNING: ${message}`);
    }

    /**
     * Log error
     */
    protected error(message: string, error?: any): void {
        this.outputChannel.appendLine(`[${this.name}] ERROR: ${message}`);
        if (error) {
            this.outputChannel.appendLine(`[${this.name}] ERROR DETAILS: ${error}`);
        }
    }

    /**
     * Check if file should be included based on patterns
     */
    protected shouldIncludeFile(filePath: string): boolean {
        const excludePatterns = this.config.options.excludePatterns || [];
        const includePatterns = this.config.options.includePatterns || [];

        // Check exclude patterns first
        for (const pattern of excludePatterns) {
            if (this.matchesPattern(filePath, pattern)) {
                return false;
            }
        }

        // If include patterns are specified, file must match at least one
        if (includePatterns.length > 0) {
            return includePatterns.some(pattern => this.matchesPattern(filePath, pattern));
        }

        return true;
    }

    /**
     * Check if string matches glob-like pattern
     */
    protected matchesPattern(text: string, pattern: string): boolean {
        // Simple glob pattern matching - could be enhanced with a proper glob library
        const regexPattern = pattern
            .replace(/\*\*/g, '.*')  // ** matches any characters including /
            .replace(/\*/g, '[^/]*') // * matches any characters except /
            .replace(/\?/g, '[^/]'); // ? matches any single character except /

        const regex = new RegExp('^' + regexPattern + '$');
        return regex.test(text);
    }

    /**
     * Get file stats if file exists
     */
    protected async getFileStats(filePath: string): Promise<vscode.FileStat | null> {
        try {
            return await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        } catch {
            return null;
        }
    }

    /**
     * Read file content safely
     */
    protected async readFileContent(filePath: string): Promise<string | null> {
        try {
            const uri = vscode.Uri.file(filePath);
            const content = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(content).toString('utf8');
        } catch (error) {
            this.debug(`Failed to read file ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Check if VS Code is in a valid state for collection
     */
    protected isValidVSCodeState(): boolean {
        // Check if there's an active workspace
        if (!vscode.workspace.workspaceFolders?.length) {
            return false;
        }

        // Add other state checks as needed
        return true;
    }

    /**
     * Update performance metrics
     */
    private updatePerformanceMetrics(duration: number, success: boolean): void {
        this.collectCount++;
        this.totalDuration += duration;

        if (!success) {
            this.errorCount++;
        }
    }

    /**
     * Dispose of collector resources
     */
    dispose(): void {
        this.isDisposed = true;
        this.outputChannel.appendLine(`[${this.name}] Collector disposed`);
    }
} 