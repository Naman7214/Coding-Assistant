import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate SHA-256 hash of a string
 */
export function hashString(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Generate SHA-256 hash of a file
 */
export async function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Generate hash for workspace path (used as unique identifier)
 */
export function hashWorkspacePath(workspacePath: string): string {
    return hashString(path.resolve(workspacePath)).substring(0, 40);
}

/**
 * Generate obfuscated path using workspace hash as key
 */
export function obfuscatePath(filePath: string, workspaceHash: string): string {
    const relativePath = path.relative(process.cwd(), filePath);
    return `${workspaceHash}:${hashString(relativePath)}`;
}

/**
 * Generate hash for a code chunk
 */
export function hashChunk(content: string, filePath: string, startLine: number, endLine: number): string {
    const chunkIdentifier = `${filePath}:${startLine}:${endLine}:${content}`;
    return hashString(chunkIdentifier);
}

/**
 * Generate combined hash from multiple hashes (for merkle tree)
 */
export function combineHashes(hashes: string[]): string {
    const combined = hashes.sort().join('');
    return hashString(combined);
} 