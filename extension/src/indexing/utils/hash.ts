import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
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
 * Get or generate encryption key for path obfuscation
 */
function getEncryptionKey(): string {
    const keyFilePath = path.join(os.homedir(), '.vscode-cga-key');

    try {
        if (fs.existsSync(keyFilePath)) {
            return fs.readFileSync(keyFilePath, 'utf8');
        }
    } catch (error) {
        // If file doesn't exist or can't be read, generate new key
    }

    // Generate random 32-byte key for AES-256
    const key = crypto.randomBytes(32).toString('hex');

    try {
        fs.writeFileSync(keyFilePath, key, 'utf8');
    } catch (error) {
        // Fallback to in-memory key if file write fails
        console.warn('Could not persist encryption key, using session key');
    }

    return key;
}

/**
 * Simple deterministic encryption using XOR with persistent key
 * Same input always produces same output
 */
function encrypt(text: string): string {
    const key = getEncryptionKey();
    const keyBytes = Buffer.from(key, 'hex');
    const textBytes = Buffer.from(text, 'utf8');

    const encrypted = Buffer.alloc(textBytes.length);

    // XOR each byte with cycling key
    for (let i = 0; i < textBytes.length; i++) {
        encrypted[i] = textBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    // Return as hex string
    return encrypted.toString('hex');
}

/**
 * Simple deterministic decryption using XOR with persistent key
 * XOR is symmetric, so decryption is same as encryption
 */
export function decrypt(encryptedHex: string): string {
    const key = getEncryptionKey();
    const keyBytes = Buffer.from(key, 'hex');
    const encryptedBytes = Buffer.from(encryptedHex, 'hex');

    const decrypted = Buffer.alloc(encryptedBytes.length);

    // XOR each byte with cycling key (same as encryption)
    for (let i = 0; i < encryptedBytes.length; i++) {
        decrypted[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    // Return as UTF-8 string
    return decrypted.toString('utf8');
}

/**
 * Generate obfuscated path using encryption (reversible)
 * Now simply encrypts the absolute path directly
 */
export function obfuscatePath(filePath: string, workspaceHash?: string): string {
    // Convert to absolute path if not already
    const absolutePath = path.resolve(filePath);
    // Normalize path separators for consistency across platforms
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    return encrypt(normalizedPath);
}

/**
 * Decrypt obfuscated path back to original absolute path
 */
export function deobfuscatePath(obfuscatedPath: string): string {
    return decrypt(obfuscatedPath);
}

/**
 * Generate hash for a code chunk
 */
export function hashChunk(content: string, filePath: string, startLine: number, endLine: number): string {
    const chunkIdentifier = `${filePath}:${startLine}:${endLine}:${content}`;
    return hashString(chunkIdentifier);
}

/**
 * Generate raw hash for chunk content only (used for embedding reuse)
 */
export function hashRawChunk(content: string): string {
    return hashString(content);
}

/**
 * Generate combined hash from multiple hashes (for merkle tree)
 */
export function combineHashes(hashes: string[]): string {
    const combined = hashes.sort().join('');
    return hashString(combined);
} 