export interface CodeChunk {
    chunk_hash: string;
    content: string;
    obfuscated_path: string;
    start_line: number;
    end_line: number;
    language: string;        // "python", "javascript" - helps with embedding context
    chunk_type: string[];    // ["function", "class", "import", "method", "variables"] etc - minimal semantic info as array
    git_branch: string;      // current git branch
    token_count: number;     // number of tokens in the chunk
}

export interface MerkleTreeNode {
    hash: string;
    filePath: string;
    lastModified: number;
    fileSize: number;
    children?: MerkleTreeNode[];
}

export interface IndexingConfig {
    workspaceHash: string;
    lastIndexTime: number;
    merkleTreeRoot: string;
    gitBranch: string;
    excludePatterns: string[];
    includePatterns: string[];
}

export interface ChunkingResult {
    chunks: CodeChunk[];
    errors: string[];
    processedFiles: number;
    totalFiles: number;
}

export interface FileChangeInfo {
    filePath: string;
    changeType: 'added' | 'modified' | 'deleted';
    oldHash?: string;
    newHash?: string;
}

export interface IndexingStats {
    totalChunks: number;
    totalFiles: number;
    lastIndexTime: number;
    processingTime: number;
    changedFiles: number;
} 