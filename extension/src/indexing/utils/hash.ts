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
 * Encrypt a string using AES-256-CBC (simple and reliable)
 */
function encrypt(text: string): string {
    const key = Buffer.from(getEncryptionKey(), 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Combine iv + encrypted data
    return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a string using AES-256-CBC
 */
export function decrypt(encryptedText: string): string {
    const key = Buffer.from(getEncryptionKey(), 'hex');
    const parts = encryptedText.split(':');

    if (parts.length !== 2) {
        throw new Error('Invalid encrypted text format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Generate obfuscated path using encryption (reversible)
 * Now simply encrypts the absolute path directly
 */
export function obfuscatePath(filePath: string, workspaceHash?: string): string {
    // Convert to absolute path if not already
    const absolutePath = path.resolve(filePath);
    return encrypt(absolutePath);
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
 * Generate combined hash from multiple hashes (for merkle tree)
 */
export function combineHashes(hashes: string[]): string {
    const combined = hashes.sort().join('');
    return hashString(combined);
} 