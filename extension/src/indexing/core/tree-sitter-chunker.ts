import * as fs from 'fs';
import * as path from 'path';
import { CodeChunk } from '../types/chunk';
import { hashChunk, obfuscatePath } from '../utils/hash';

// Import Chonkie CodeChunker
import { CodeChunker } from 'chonkie';

interface ChonkieCodeChunk {
    text: string;
    startIndex: number;
    endIndex: number;
    tokenCount: number;
    lang: string;
    nodes: any[];
}

export class TreeSitterChunker {
    private workspaceHash: string;
    private gitBranch: string;
    private chunkers: Map<string, any>;

    // Configuration
    private readonly CHUNK_SIZE = 512;
    private readonly INCLUDE_NODES = true;

    constructor(workspaceHash: string, gitBranch: string) {
        this.workspaceHash = workspaceHash;
        this.gitBranch = gitBranch;
        this.chunkers = new Map();
    }

    /**
     * Get or create a CodeChunker for the specified language
     */
    private async getChunker(language: string): Promise<any> {
        if (this.chunkers.has(language)) {
            return this.chunkers.get(language);
        }

        try {
            const chunker = await CodeChunker.create({
                lang: language,
                chunkSize: this.CHUNK_SIZE,
                includeNodes: this.INCLUDE_NODES
            });
            this.chunkers.set(language, chunker);
            return chunker;
        } catch (error) {
            console.warn(`Failed to create Chonkie chunker for language ${language}:`, error);
            return null;
        }
    }

    /**
     * Chunk a single file using Chonkie CodeChunker
     */
    async chunkFile(filePath: string): Promise<CodeChunk[]> {
        try {
            console.log(`[TreeSitterChunker] Starting to chunk file: ${filePath}`);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const language = this.detectLanguage(filePath);

            console.log(`[TreeSitterChunker] Detected language: ${language} for file: ${filePath}`);

            if (!language) {
                console.log(`[TreeSitterChunker] No language detected for file: ${filePath}`);
                return [];
            }

            const chunker = await this.getChunker(language);
            if (!chunker) {
                console.log(`[TreeSitterChunker] No Chonkie chunker available for ${language}, using fallback for: ${filePath}`);
                // Fallback to simple text chunking if Chonkie doesn't support the language
                const fallbackChunks = this.fallbackTextChunking(content, filePath, language);
                console.log(`[TreeSitterChunker] Generated ${fallbackChunks.length} fallback chunks for: ${filePath}`);
                return fallbackChunks;
            }

            console.log(`[TreeSitterChunker] Using Chonkie chunker for ${language}: ${filePath}`);
            const chonkieChunks: ChonkieCodeChunk[] = await chunker.chunk(content);

            // Debug: Log the actual structure of the first chunk
            if (chonkieChunks.length > 0) {
                console.log(`[TreeSitterChunker] DEBUG - First chunk structure:`, JSON.stringify(chonkieChunks[0], null, 2));
                console.log(`[TreeSitterChunker] DEBUG - Available properties:`, Object.keys(chonkieChunks[0]));
            }

            const convertedChunks = this.convertChonkieChunks(chonkieChunks, content, filePath, language);
            console.log(`[TreeSitterChunker] Generated ${convertedChunks.length} chunks for: ${filePath}`);
            return convertedChunks;

        } catch (error) {
            console.error(`[TreeSitterChunker] Error chunking file ${filePath}:`, error);
            return [];
        }
    }

    /**
 * Convert Chonkie chunks to our CodeChunk format
 */
    private convertChonkieChunks(
        chonkieChunks: ChonkieCodeChunk[],
        originalContent: string,
        filePath: string,
        language: string
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];

        for (let i = 0; i < chonkieChunks.length; i++) {
            const chonkieChunk = chonkieChunks[i];

            // Use the exact values provided by Chonkie (camelCase)
            const startIndex = chonkieChunk.startIndex;
            const endIndex = chonkieChunk.endIndex;

            const startLine = this.getLineFromIndex(originalContent, startIndex);
            const endLine = this.getEndLineFromIndex(originalContent, endIndex);

            console.log(`[TreeSitterChunker] Chunk ${i + 1}: startIndex=${startIndex}, endIndex=${endIndex}, start_line=${startLine}, end_line=${endLine}`);
            console.log(`[TreeSitterChunker] Chunk ${i + 1} content preview: "${chonkieChunk.text.substring(0, 50)}..."`);

            const chunkTypes = this.extractSemanticTypes(chonkieChunk.nodes);

            const chunk: CodeChunk = {
                chunk_hash: hashChunk(chonkieChunk.text, filePath, startLine, endLine),
                content: chonkieChunk.text,
                obfuscated_path: obfuscatePath(filePath, this.workspaceHash),
                start_line: startLine,
                end_line: endLine,
                language: language,
                chunk_type: chunkTypes,
                git_branch: this.gitBranch,
                token_count: chonkieChunk.tokenCount
            };

            chunks.push(chunk);
        }

        return chunks;
    }

    /**
     * Calculate line number from character index (1-indexed)
     */
    private getLineFromIndex(content: string, index: number): number {
        if (index <= 0) return 1;
        if (index >= content.length) {
            return content.split('\n').length;
        }

        const beforeIndex = content.substring(0, index);
        const lineNumber = beforeIndex.split('\n').length;
        return lineNumber;
    }

    /**
 * Calculate line number from character index, ensuring we don't go beyond the actual line
 */
    private getEndLineFromIndex(content: string, index: number): number {
        if (index <= 0) return 1;
        if (index >= content.length) {
            return content.split('\n').length;
        }

        // For end index, we want to include the line where the character at index is located
        const beforeAndAtIndex = content.substring(0, index + 1);
        const lineNumber = beforeAndAtIndex.split('\n').length;

        // If the index points to a newline character, we should consider the previous line
        if (content[index] === '\n' && index > 0) {
            return lineNumber - 1;
        }

        return lineNumber;
    }



    /**
     * Extract semantic types from AST nodes
     */
    private extractSemanticTypes(nodes: any[]): string[] {
        const semanticTypes = new Set<string>();

        if (!nodes || nodes.length === 0) {
            return ['text'];
        }

        for (const node of nodes) {
            if (node.tree && node.tree.language && node.tree.language.types) {
                const types = node.tree.language.types;

                // Look for common semantic patterns in the types array
                for (const type of types) {
                    if (typeof type === 'string') {
                        const semanticType = this.mapToSemanticType(type);
                        if (semanticType) {
                            semanticTypes.add(semanticType);
                        }
                    }
                }
            }

            // Also check the node type directly if available
            if (node.type) {
                const semanticType = this.mapToSemanticType(node.type);
                if (semanticType) {
                    semanticTypes.add(semanticType);
                }
            }
        }

        return semanticTypes.size > 0 ? Array.from(semanticTypes) : ['block'];
    }

    /**
     * Map tree-sitter types to semantic categories
     */
    private mapToSemanticType(type: string): string | null {
        const typeMap: { [key: string]: string } = {
            // Function related
            'def': 'function',
            'function': 'function',
            'function_definition': 'function',
            'function_declaration': 'function',
            'method_definition': 'method',
            'arrow_function': 'function',
            'lambda': 'function',

            // Class related
            'class': 'class',
            'class_definition': 'class',
            'class_declaration': 'class',

            // Import/Export
            'import': 'import',
            'from': 'import',
            'import_statement': 'import',
            'import_from_statement': 'import',
            'export': 'export',
            'export_statement': 'export',

            // Variable/Assignment
            'assignment': 'variable',
            'variable_declaration': 'variable',
            'identifier': 'variable',

            // Control flow
            'if': 'control_flow',
            'elif': 'control_flow',
            'else': 'control_flow',
            'for': 'control_flow',
            'while': 'control_flow',
            'try': 'control_flow',
            'except': 'control_flow',
            'finally': 'control_flow',
            'with': 'control_flow',
            'match': 'control_flow',
            'case': 'control_flow',

            // Interface/Type related
            'interface': 'interface',
            'interface_declaration': 'interface',
            'type': 'type',
            'type_alias_declaration': 'type',

            // Async
            'async': 'async',

            // Decorator
            '@': 'decorator',

            // Return statements
            'return': 'return'
        };

        return typeMap[type] || null;
    }

    /**
     * Fallback text chunking when Chonkie doesn't support the language
     */
    private fallbackTextChunking(content: string, filePath: string, language: string): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const lines = content.split('\n');
        const maxChunkSize = 512; // tokens
        const avgTokensPerChar = 0.25; // Rough estimate
        const maxCharsPerChunk = Math.floor(maxChunkSize / avgTokensPerChar);

        let currentIndex = 0;
        while (currentIndex < content.length) {
            const endIndex = Math.min(currentIndex + maxCharsPerChunk, content.length);

            // Try to break at a natural boundary (newline, space, etc.)
            let actualEndIndex = endIndex;
            if (endIndex < content.length) {
                const nextNewline = content.indexOf('\n', endIndex);
                const nextSpace = content.indexOf(' ', endIndex);

                // Choose the nearest natural break within a reasonable distance
                const candidates = [nextNewline, nextSpace].filter(idx => idx !== -1 && idx - endIndex <= 100);
                if (candidates.length > 0) {
                    actualEndIndex = Math.min(...candidates);
                }
            }

            const chunkContent = content.substring(currentIndex, actualEndIndex);

            if (chunkContent.trim().length === 0) {
                currentIndex = actualEndIndex;
                continue;
            }

            const startLine = this.getLineFromIndex(content, currentIndex);
            const endLine = this.getEndLineFromIndex(content, actualEndIndex - 1);

            // Estimate token count (rough approximation)
            const estimatedTokens = Math.ceil(chunkContent.length * avgTokensPerChar);

            const chunk: CodeChunk = {
                chunk_hash: hashChunk(chunkContent, filePath, startLine, endLine),
                content: chunkContent,
                obfuscated_path: obfuscatePath(filePath, this.workspaceHash),
                start_line: startLine,
                end_line: endLine,
                language: language,
                chunk_type: ['text'],
                git_branch: this.gitBranch,
                token_count: estimatedTokens
            };

            chunks.push(chunk);
            currentIndex = actualEndIndex;
        }

        return chunks;
    }

    /**
     * Detect programming language from file extension
     */
    private detectLanguage(filePath: string): string | null {
        const ext = path.extname(filePath).toLowerCase();

        const languageMap: { [key: string]: string } = {
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.cs': 'csharp',
            '.php': 'php',
            '.rb': 'ruby',
            '.go': 'go',
            '.rs': 'rust',
            '.kt': 'kotlin',
            '.swift': 'swift',
            '.scala': 'scala',
            '.html': 'html',
            '.htm': 'html',
            '.css': 'css',
            '.scss': 'css',
            '.sass': 'css',
            '.less': 'css',
            '.json': 'json',
            '.xml': 'xml',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.toml': 'toml',
            '.md': 'markdown',
            '.sql': 'sql',
            '.sh': 'bash',
            '.bash': 'bash',
            '.zsh': 'bash',
            '.ps1': 'powershell',
            '.r': 'r',
            '.m': 'matlab',
            '.lua': 'lua',
            '.perl': 'perl',
            '.pl': 'perl'
        };

        return languageMap[ext] || null;
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.chunkers.clear();
    }
}
