import * as vscode from 'vscode';
import { IndexingManager, IndexingManagerConfig } from './IndexingManager';

// Main indexing module exports
export { GitMonitor } from './core/git-monitor';
export { IndexingOrchestrator } from './core/indexing-orchestrator';
export { MerkleTreeBuilder } from './core/merkle-tree-builder';
export { TreeSitterChunker } from './core/tree-sitter-chunker';
export { IndexingManager, IndexingManagerConfig, IndexingStatusInfo } from './IndexingManager';
export { VSCodeStorageManager } from './storage/vscode-storage';

// Type exports
export {
    ChunkingResult, CodeChunk, FileChangeInfo, IndexingConfig, IndexingStats, MerkleTreeNode
} from './types/chunk';

// Utility exports
export {
    combineHashes, hashChunk, hashFile, hashString, hashWorkspacePath,
    obfuscatePath
} from './utils/hash';

/**
 * Initialize code base indexing for a workspace using IndexingManager
 * This is the main entry point for the indexing system
 */
export async function initializeIndexing(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    config?: Partial<IndexingManagerConfig>
): Promise<IndexingManager> {
    const indexingManager = new IndexingManager(context, outputChannel, config);
    await indexingManager.initialize();
    return indexingManager;
}
