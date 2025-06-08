# Code Base Indexing System

A sophisticated client-side code base indexing system for VSCode extensions that efficiently tracks, chunks, and indexes code changes using Merkle trees and semantic analysis.

## 🚀 Features

- **Efficient Change Detection**: Uses Merkle trees to detect file changes with minimal overhead
- **Semantic Code Chunking**: Leverages chonkie for intelligent parsing and semantic chunking
- **Git Integration**: Automatically handles branch changes and triggers re-indexing
- **Persistent Storage**: Uses VSCode's storage API for reliable data persistence
- **Server Synchronization**: Compresses and sends chunks to server for embedding calculation
- **Performance Optimized**: Processes files in batches with configurable concurrency
- **Real-time Monitoring**: Provides status updates and statistics

## 📁 Architecture

```
extension/src/indexing/
├── types/                  # TypeScript interfaces and types
│   └── chunk.ts           # Core data structures
├── utils/                  # Utility functions
│   └── hash.ts            # Hashing utilities
├── core/                   # Core indexing components
│   ├── merkle-tree-builder.ts      # Merkle tree construction and comparison
│   ├── tree-sitter-chunker.ts      # Semantic code chunking
│   ├── git-monitor.ts              # Git branch monitoring
│   ├── indexing-orchestrator.ts    # Main orchestration logic
│   └── server-communication.ts     # Server API communication
├── storage/                # Data persistence
│   └── vscode-storage.ts   # VSCode storage integration
├── index.ts               # Main module exports
└── README.md             # This file
```

## 🔧 Technology Stack

### Client-Side Dependencies
- **chonkie**: for chunking
- **MerkleTreeJS**: Merkle tree implementation for change detection
- **VSCode API**: Storage and file system integration
- **Node.js zlib**: Data compression
- **Axios**: HTTP client for server communication

### Supported Languages
- JavaScript/TypeScript
- Python
- Java
- C/C++
- C#, PHP, Ruby, Go, Rust, Swift, Kotlin

## 🎯 Core Components

### 1. Merkle Tree Builder (`merkle-tree-builder.ts`)

Builds and compares Merkle trees for efficient change detection:

```typescript
const builder = new MerkleTreeBuilder();
const merkleTree = await builder.buildTree(workspacePath);
const changedFiles = builder.compareTree(oldTree, newTree);
```

**Features:**
- File filtering with glob patterns
- Recursive directory traversal
- Hash-based change detection
- Configurable include/exclude patterns

### 2. Tree-sitter Chunker (`tree-sitter-chunker.ts`)

Performs semantic code chunking using Tree-sitter parsers:

```typescript
const chunker = new TreeSitterChunker(workspaceHash, gitBranch);
const chunks = await chunker.chunkFile(filePath);
```

**Chunk Schema:**
export interface CodeChunk {
    chunk_hash: string;
    content: string;
    obfuscated_path: string;
    start_line: number;
    end_line: number;
    language: string;        // "python", "javascript" - helps with embedding context
    chunk_type: string[];    // ["function", "class", "import", "method", "variables"] etc - minimal semantic info as array
    git_branch: string;      // current git branch
}

```

### 3. Git Monitor (`git-monitor.ts`)

Monitors Git repository for branch changes:

```typescript
const gitMonitor = new GitMonitor(workspacePath);
await gitMonitor.initialize();

gitMonitor.onBranchChange((newBranch, oldBranch) => {
  console.log(`Branch changed: ${oldBranch} → ${newBranch}`);
});
```

**Features:**
- Real-time branch change detection
- File system watchers for `.git/HEAD`
- Periodic fallback checking
- Git status information

### 4. Indexing Orchestrator (`indexing-orchestrator.ts`)

Main coordinator that manages the entire indexing process:

```typescript
const orchestrator = new IndexingOrchestrator(context, workspacePath);
await orchestrator.initialize();

orchestrator.onChunksReady((chunks) => {
  // Handle new chunks
});
```

**Process Flow:**
1. Build new Merkle tree
2. Compare with previous tree
3. Identify changed files
4. Process files in batches
5. Extract semantic chunks
6. Compress and store data
7. Send to server (optional)

### 5. Storage Manager (`vscode-storage.ts`)

Handles persistent storage using VSCode APIs:

```typescript
const storage = new VSCodeStorageManager(context, workspaceHash);
await storage.saveMerkleTree(merkleTree);
const compressedPath = await storage.saveCompressedChunks(chunks);
```

**Storage Strategy:**
- Merkle tree: VSCode storage (small, persistent)
- Configuration: VSCode `globalState`
- Chunks: Sent directly to server (no local storage)
- Privacy: Only semantic chunks transmitted, never complete files

## ⚙️ Configuration

The system runs with a **10-minute indexing cycle** and can be configured:

```typescript
// Default configuration
const INDEXING_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_FILES = 10;

// File patterns
const excludePatterns = [
  'node_modules/**',
  '.git/**',
  '**/*.log',
  '**/dist/**',
  '**/build/**'
];

const includePatterns = [
  '**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx',
  '**/*.py', '**/*.java', '**/*.cpp', '**/*.c'
];
```

## 🚀 Quick Start

### 1. Installation

```bash
npm install chonkie
### 2. Basic Integration

```typescript
import { initializeIndexing } from './indexing';

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const orchestrator = await initializeIndexing(
      context,
      workspaceFolder.uri.fsPath
    );
    
    // Set up callbacks
    orchestrator.onChunksReady((chunks) => {
      console.log(`Received ${chunks.length} new chunks`);
    });
  }
}
```

### 3. Advanced Integration

See `integration-example.ts` for a complete example with:
- Status bar integration
- Server communication
- Error handling
- User notifications

## 📊 Performance Characteristics

### Memory Usage
- **Merkle Tree**: ~50KB for 1000 files (stored locally)
- **Chunks**: ~1KB per chunk average (sent to server)
- **Local Storage**: Minimal (~1-5MB per workspace)

### Processing Speed
- **Tree Building**: ~100 files/second
- **Chunking**: ~50 files/second
- **Comparison**: Near-instantaneous for unchanged files

### Privacy & Efficiency
- **No Complete Files**: Only semantic chunks transmitted
- **No Real Paths**: File paths are obfuscated with hashes
- **Direct Transmission**: Chunks sent directly to server

## 🔄 Indexing Workflow

```mermaid
graph TD
    A[Timer Trigger/Manual] --> B[Build Merkle Tree]
    B --> C[Compare with Previous]
    C --> D{Files Changed?}
    D -->|No| E[Update Timestamp]
    D -->|Yes| F[Process Changed Files]
    F --> G[Extract Semantic Chunks]
    G --> H[Generate Chunk Hashes]
    H --> I[Send Chunks to Server]
    I --> J[Update Merkle Tree]
    J --> K[Update Configuration]
    L --> E
```

## 🌐 Server Integration

The system integrates with a server-side component for:

### Endpoints
- `POST /api/indexing/upload-chunks` - Upload chunk data
- `GET /api/indexing/status/{workspace_hash}` - Get indexing status
- `GET /api/health` - Health check

### Data Flow
1. Client compresses chunks with gzip
2. POST to server with workspace hash
3. Server calculates embeddings
4. Storage in MongoDB + Pinecone
