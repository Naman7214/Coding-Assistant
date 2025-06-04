import NodeCache from 'node-cache';
import * as vscode from 'vscode';
import { CacheEntry, ContextData } from '../types/context';

export interface CacheStats {
    hits: number;
    misses: number;
    hitRate: number;
    totalKeys: number;
    memoryUsage: number;
    averageRetrievalTime: number;
}

export interface CacheConfiguration {
    defaultTtl: number;          // Default TTL in seconds
    checkPeriod: number;         // Cleanup interval in seconds
    maxKeys: number;             // Maximum number of keys to store
    maxMemoryUsage: number;      // Maximum memory usage in bytes
    enableStatistics: boolean;   // Whether to track statistics
    compressionThreshold: number; // Size threshold for compression
}

export class CacheManager {
    private cache: NodeCache;
    private stats: CacheStats;
    private config: CacheConfiguration;
    private outputChannel: vscode.OutputChannel;
    private compressionEnabled: boolean = false;
    private startTime: number = Date.now();

    constructor(
        outputChannel: vscode.OutputChannel,
        config?: Partial<CacheConfiguration>
    ) {
        this.outputChannel = outputChannel;

        // Default configuration
        this.config = {
            defaultTtl: 3600,           // 1 hour
            checkPeriod: 600,           // 10 minutes
            maxKeys: 10000,             // 10k keys
            maxMemoryUsage: 100 * 1024 * 1024, // 100MB
            enableStatistics: true,
            compressionThreshold: 1024,  // 1KB
            ...config
        };

        // Initialize cache
        this.cache = new NodeCache({
            stdTTL: this.config.defaultTtl,
            checkperiod: this.config.checkPeriod,
            maxKeys: this.config.maxKeys,
            useClones: false,
            deleteOnExpire: true
        });

        // Initialize statistics
        this.stats = {
            hits: 0,
            misses: 0,
            hitRate: 0,
            totalKeys: 0,
            memoryUsage: 0,
            averageRetrievalTime: 0
        };

        // Set up event listeners
        this.setupEventListeners();

        this.outputChannel.appendLine(`[CacheManager] Initialized with config: ${JSON.stringify(this.config)}`);
    }

    private setupEventListeners(): void {
        // Cache hit/miss events
        this.cache.on('set', (key: string) => {
            if (this.config.enableStatistics) {
                this.stats.totalKeys = this.cache.keys().length;
                this.updateMemoryUsage();
            }
        });

        this.cache.on('del', (key: string) => {
            if (this.config.enableStatistics) {
                this.stats.totalKeys = this.cache.keys().length;
                this.updateMemoryUsage();
            }
        });

        this.cache.on('expired', (key: string) => {
            this.outputChannel.appendLine(`[CacheManager] Key expired: ${key}`);
        });
    }

    /**
     * Store data in cache with optional TTL and metadata
     */
    async set<T>(
        key: string,
        data: T,
        ttl?: number,
        metadata?: Record<string, any>
    ): Promise<void> {
        try {
            const startTime = Date.now();

            const cacheEntry: CacheEntry<T> = {
                data,
                timestamp: Date.now(),
                ttl: ttl || this.config.defaultTtl,
                version: this.generateVersion(),
                ...metadata
            };

            // Check if compression is needed
            const serialized = JSON.stringify(cacheEntry);
            const shouldCompress = this.compressionEnabled &&
                serialized.length > this.config.compressionThreshold;

            const finalData = shouldCompress ?
                await this.compress(serialized) :
                cacheEntry;

            // Store in cache
            const success = this.cache.set(key, finalData);

            if (!success) {
                throw new Error(`Failed to store key: ${key}`);
            }

            // If a custom TTL was specified, set it using the ttl method
            if (ttl && ttl !== this.config.defaultTtl) {
                this.cache.ttl(key, ttl);
            }

            // Update statistics
            if (this.config.enableStatistics) {
                this.updateMemoryUsage();
                const duration = Date.now() - startTime;
                this.outputChannel.appendLine(
                    `[CacheManager] Stored key: ${key} (${duration}ms, compressed: ${shouldCompress})`
                );
            }

            // Check memory limits
            await this.enforceMemoryLimits();

        } catch (error) {
            this.outputChannel.appendLine(`[CacheManager] Error storing key ${key}: ${error}`);
            throw error;
        }
    }

    /**
     * Retrieve data from cache
     */
    async get<T>(key: string): Promise<CacheEntry<T> | null> {
        try {
            const startTime = Date.now();
            const cached = this.cache.get<CacheEntry<T> | string>(key);

            if (cached === undefined) {
                if (this.config.enableStatistics) {
                    this.stats.misses++;
                    this.updateHitRate();
                }
                return null;
            }

            // Handle compressed data
            let result: CacheEntry<T>;
            if (typeof cached === 'string') {
                result = JSON.parse(await this.decompress(cached));
            } else {
                result = cached;
            }

            if (this.config.enableStatistics) {
                this.stats.hits++;
                this.updateHitRate();
                const duration = Date.now() - startTime;
                this.updateAverageRetrievalTime(duration);
            }

            return result;

        } catch (error) {
            this.outputChannel.appendLine(`[CacheManager] Error retrieving key ${key}: ${error}`);
            if (this.config.enableStatistics) {
                this.stats.misses++;
                this.updateHitRate();
            }
            return null;
        }
    }

    /**
     * Check if key exists in cache
     */
    has(key: string): boolean {
        return this.cache.has(key);
    }

    /**
     * Delete specific key from cache
     */
    delete(key: string): boolean {
        const result = this.cache.del(key);
        if (this.config.enableStatistics) {
            this.stats.totalKeys = this.cache.keys().length;
            this.updateMemoryUsage();
        }
        return result > 0;
    }

    /**
     * Clear all cache entries or entries matching pattern
     */
    clear(pattern?: string): void {
        if (pattern) {
            const keys = this.cache.keys();
            const regex = new RegExp(pattern);
            const keysToDelete = keys.filter(key => regex.test(key));
            this.cache.del(keysToDelete);
            this.outputChannel.appendLine(`[CacheManager] Cleared ${keysToDelete.length} keys matching pattern: ${pattern}`);
        } else {
            this.cache.flushAll();
            this.outputChannel.appendLine('[CacheManager] Cleared all cache entries');
        }

        if (this.config.enableStatistics) {
            this.stats.totalKeys = this.cache.keys().length;
            this.updateMemoryUsage();
        }
    }

    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        if (this.config.enableStatistics) {
            this.updateMemoryUsage();
            return { ...this.stats };
        }
        return this.stats;
    }

    /**
     * Get cache configuration
     */
    getConfig(): CacheConfiguration {
        return { ...this.config };
    }

    /**
     * Update cache configuration
     */
    updateConfig(newConfig: Partial<CacheConfiguration>): void {
        this.config = { ...this.config, ...newConfig };
        this.outputChannel.appendLine('[CacheManager] Configuration updated');
    }

    /**
     * Get all keys in cache
     */
    getKeys(): string[] {
        return this.cache.keys();
    }

    /**
     * Get keys matching pattern
     */
    getKeysMatching(pattern: string): string[] {
        const keys = this.cache.keys();
        const regex = new RegExp(pattern);
        return keys.filter(key => regex.test(key));
    }

    /**
     * Store context data with automatic key generation
     */
    async storeContextData(
        workspaceId: string,
        type: string,
        data: ContextData,
        ttl?: number
    ): Promise<string> {
        const key = this.generateContextKey(workspaceId, type, data.id);
        await this.set(key, data, ttl);
        return key;
    }

    /**
     * Retrieve context data by type and ID
     */
    async getContextData(
        workspaceId: string,
        type: string,
        id: string
    ): Promise<ContextData | null> {
        const key = this.generateContextKey(workspaceId, type, id);
        const entry = await this.get<ContextData>(key);
        return entry?.data || null;
    }

    /**
     * Store file content with intelligent caching
     */
    async storeFileContent(
        workspaceId: string,
        filePath: string,
        content: string,
        metadata?: any
    ): Promise<void> {
        const key = this.generateFileKey(workspaceId, filePath);
        const contextData: ContextData = {
            id: this.generateId(),
            type: 'file_content',
            timestamp: Date.now(),
            weight: 1.0,
            data: { content, filePath },
            metadata
        };

        // Use shorter TTL for large files
        const ttl = content.length > 50000 ? 1800 : this.config.defaultTtl; // 30 min vs 1 hour
        await this.set(key, contextData, ttl);
    }

    /**
     * Get file content from cache
     */
    async getFileContent(workspaceId: string, filePath: string): Promise<string | null> {
        const key = this.generateFileKey(workspaceId, filePath);
        const entry = await this.get<ContextData>(key);
        return entry?.data?.data?.content || null;
    }

    /**
     * Preload frequently used data
     */
    async preloadWorkspaceData(workspaceId: string): Promise<void> {
        // This would be called during workspace initialization
        // to preload commonly accessed data
        this.outputChannel.appendLine(`[CacheManager] Preloading data for workspace: ${workspaceId}`);

        // Implementation would depend on usage patterns
        // Could preload recent files, project structure, etc.
    }

    /**
     * Cleanup expired entries and optimize memory
     */
    async cleanup(): Promise<void> {
        const beforeCount = this.stats.totalKeys;
        const beforeMemory = this.stats.memoryUsage;

        // Manual cleanup of expired keys
        this.cache.keys().forEach(key => {
            // This will trigger automatic cleanup of expired keys
            this.cache.has(key);
        });

        await this.enforceMemoryLimits();

        const afterCount = this.cache.keys().length;
        const afterMemory = this.estimateMemoryUsage();

        this.outputChannel.appendLine(
            `[CacheManager] Cleanup completed: ${beforeCount} -> ${afterCount} keys, ` +
            `${Math.round(beforeMemory / 1024)}KB -> ${Math.round(afterMemory / 1024)}KB`
        );
    }

    // Private helper methods
    private generateContextKey(workspaceId: string, type: string, id: string): string {
        return `ctx:${workspaceId}:${type}:${id}`;
    }

    private generateFileKey(workspaceId: string, filePath: string): string {
        const pathHash = this.hashString(filePath);
        return `file:${workspaceId}:${pathHash}`;
    }

    private generateVersion(): string {
        return `v${Date.now()}`;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    private updateHitRate(): void {
        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
    }

    private updateAverageRetrievalTime(duration: number): void {
        const totalOperations = this.stats.hits + this.stats.misses;
        if (totalOperations === 1) {
            this.stats.averageRetrievalTime = duration;
        } else {
            this.stats.averageRetrievalTime =
                (this.stats.averageRetrievalTime * (totalOperations - 1) + duration) / totalOperations;
        }
    }

    private updateMemoryUsage(): void {
        this.stats.memoryUsage = this.estimateMemoryUsage();
        this.stats.totalKeys = this.cache.keys().length;
    }

    private estimateMemoryUsage(): number {
        // Simple estimation - in production you might want more accurate measurement
        const keys = this.cache.keys();
        let totalSize = 0;

        keys.forEach(key => {
            try {
                const value = this.cache.get(key);
                if (value) {
                    totalSize += JSON.stringify(value).length * 2; // Rough estimate (UTF-16)
                }
            } catch (error) {
                // Ignore errors during estimation
            }
        });

        return totalSize;
    }

    private async enforceMemoryLimits(): Promise<void> {
        if (this.stats.memoryUsage > this.config.maxMemoryUsage) {
            const keys = this.cache.keys();
            const keysToRemove = Math.ceil(keys.length * 0.1); // Remove 10% oldest

            // Sort keys by access time (if available) or remove random keys
            const removedKeys = keys.slice(0, keysToRemove);
            this.cache.del(removedKeys);

            this.outputChannel.appendLine(
                `[CacheManager] Memory limit enforced: removed ${removedKeys.length} keys`
            );

            this.updateMemoryUsage();
        }
    }

    private async compress(data: string): Promise<string> {
        // Simple compression placeholder - in production use proper compression
        // Could use zlib, lz4, or other compression libraries
        return data; // For now, return as-is
    }

    private async decompress(data: string): Promise<string> {
        // Decompression placeholder
        return data;
    }

    /**
     * Dispose of cache manager
     */
    dispose(): void {
        this.cache.flushAll();
        this.cache.close();
        this.outputChannel.appendLine('[CacheManager] Disposed');
    }
} 