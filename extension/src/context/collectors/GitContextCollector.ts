import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager } from '../storage/CacheManager';
import { CollectorMetadata, GitCollectorData } from '../types/collectors';
import { ContextData } from '../types/context';
import { BaseCollector } from './base/BaseCollector';

interface GitCommand {
    command: string;
    args: string[];
    cwd: string;
}

interface GitCommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    authorEmail: string;
    date: Date;
    filesChanged: string[];
    insertions: number;
    deletions: number;
}

interface GitBranchInfo {
    current: string;
    all: string[];
    remote: string[];
    upstream?: string;
    ahead: number;
    behind: number;
}

export class GitContextCollector extends BaseCollector {
    constructor(
        outputChannel: vscode.OutputChannel,
        cacheManager: CacheManager,
        workspaceId: string
    ) {
        super(
            'GitContextCollector',
            'git_context',
            6.0, // Important for understanding code changes
            outputChannel,
            cacheManager,
            workspaceId,
            {
                cacheTimeout: 0, // Disable caching by setting timeout to 0
                options: {
                    maxCommits: 50,
                    maxDiffLines: 1000,
                    includeStaged: true,
                    includeUnstaged: true,
                    includeUntracked: true,
                    analyzeBranches: true,
                    includeRemotes: true,
                    trackFileHistory: true,
                    detectConflicts: true,
                    debug: false
                }
            }
        );
    }

    // Override to always return false - we never want to use cache
    protected shouldUseCache(): boolean {
        return false;
    }

    async canCollect(): Promise<boolean> {
        if (!this.isValidVSCodeState()) {
            return false;
        }

        const workspacePath = this.getWorkspacePath();
        if (!workspacePath) {
            return false;
        }

        // Check if workspace is a git repository
        return await this.isGitRepository(workspacePath);
    }

    async collect(): Promise<ContextData | null> {
        try {
            const workspacePath = this.getWorkspacePath();
            if (!workspacePath || !(await this.isGitRepository(workspacePath))) {
                return null;
            }

            // Get repository information
            const repository = await this.getRepositoryInfo(workspacePath);

            // Get status information
            const status = await this.getStatusInfo(workspacePath);

            // Get history information
            const history = await this.getHistoryInfo(workspacePath);

            // Get diff information
            const diff = await this.getDiffInfo(workspacePath);

            const data: GitCollectorData = {
                repository,
                status,
                history,
                diff
            };

            return this.createContextData(
                this.generateId(),
                data,
                {
                    isRepo: repository.isRepo,
                    branch: repository.currentBranch,
                    hasChanges: status.hasUncommittedChanges,
                    changedFilesCount: status.changedFiles.length,
                    commitsAnalyzed: history.recentCommits.length,
                    timestamp: Date.now()
                }
            );

        } catch (error) {
            this.error('Failed to collect git context', error);
            throw error;
        }
    }

    getMetadata(): CollectorMetadata {
        return {
            name: this.name,
            description: 'Analyzes git repository state including branches, commits, diffs, and file changes to understand development context',
            version: '1.0.0',
            dependencies: ['git', 'vscode.workspace'],
            configurable: true,
            cacheable: false, // Set cacheable to false
            priority: 6
        };
    }

    /**
     * Check if directory is a git repository
     */
    private async isGitRepository(workspacePath: string): Promise<boolean> {
        try {
            const result = await this.executeGitCommand({
                command: 'git',
                args: ['rev-parse', '--is-inside-work-tree'],
                cwd: workspacePath
            });
            return result.stdout.trim() === 'true';
        } catch {
            return false;
        }
    }

    /**
     * Get repository basic information
     */
    private async getRepositoryInfo(workspacePath: string): Promise<GitCollectorData['repository']> {
        const repository: GitCollectorData['repository'] = {
            isRepo: true,
            rootPath: workspacePath,
            currentBranch: 'unknown'
        };

        try {
            // Get current branch
            const branchResult = await this.executeGitCommand({
                command: 'git',
                args: ['branch', '--show-current'],
                cwd: workspacePath
            });
            repository.currentBranch = branchResult.stdout.trim() || 'HEAD';

            // Get remote URL
            try {
                const remoteResult = await this.executeGitCommand({
                    command: 'git',
                    args: ['remote', 'get-url', 'origin'],
                    cwd: workspacePath
                });
                repository.remoteUrl = remoteResult.stdout.trim();
            } catch {
                // No remote or origin not found
                this.debug('No remote origin found');
            }

            // Get git root path (might be different from workspace path)
            try {
                const rootResult = await this.executeGitCommand({
                    command: 'git',
                    args: ['rev-parse', '--show-toplevel'],
                    cwd: workspacePath
                });
                repository.rootPath = rootResult.stdout.trim();
            } catch {
                // Use workspace path as fallback
            }

        } catch (error) {
            this.debug(`Failed to get repository info: ${error}`);
        }

        return repository;
    }

    /**
     * Get repository status information
     */
    private async getStatusInfo(workspacePath: string): Promise<GitCollectorData['status']> {
        const status: GitCollectorData['status'] = {
            hasUncommittedChanges: false,
            changedFiles: [],
            untrackedFiles: []
        };

        try {
            // Get porcelain status
            const statusResult = await this.executeGitCommand({
                command: 'git',
                args: ['status', '--porcelain', '-z'],
                cwd: workspacePath
            });

            if (statusResult.stdout.trim()) {
                status.hasUncommittedChanges = true;

                // Parse porcelain output
                const files = statusResult.stdout.split('\0').filter(line => line.trim());

                for (const line of files) {
                    if (line.length < 3) continue;

                    const statusCode = line.substring(0, 2);
                    const filePath = line.substring(3);
                    const relativePath = path.relative(workspacePath, path.resolve(workspacePath, filePath));

                    // Parse status codes
                    const indexStatus = statusCode[0];
                    const workingStatus = statusCode[1];

                    if (indexStatus === '?' && workingStatus === '?') {
                        // Untracked file
                        status.untrackedFiles.push(relativePath);
                    } else {
                        // Get file diff stats
                        const diffStats = await this.getFileDiffStats(workspacePath, filePath);

                        status.changedFiles.push({
                            path: relativePath,
                            status: this.parseGitStatus(statusCode),
                            linesAdded: diffStats.insertions,
                            linesDeleted: diffStats.deletions
                        });
                    }
                }
            }

        } catch (error) {
            this.debug(`Failed to get status info: ${error}`);
        }

        return status;
    }

    /**
     * Get repository history information
     */
    private async getHistoryInfo(workspacePath: string): Promise<GitCollectorData['history']> {
        const history: GitCollectorData['history'] = {
            recentCommits: [],
            branchInfo: {
                ahead: 0,
                behind: 0
            }
        };

        try {
            // Get recent commits
            const maxCommits = this.config.options.maxCommits || 50;
            const logResult = await this.executeGitCommand({
                command: 'git',
                args: [
                    'log',
                    `--max-count=${maxCommits}`,
                    '--pretty=format:%H|%h|%s|%an|%ae|%at',
                    '--name-only',
                    '-z'
                ],
                cwd: workspacePath
            });

            if (logResult.stdout.trim()) {
                history.recentCommits = await this.parseGitLog(logResult.stdout);
            }

            // Get branch info
            if (this.config.options.analyzeBranches) {
                history.branchInfo = await this.getBranchInfo(workspacePath);
            }

        } catch (error) {
            this.debug(`Failed to get history info: ${error}`);
        }

        return history;
    }

    /**
     * Get diff information using git commands
     */
    private async getDiffInfo(workspacePath: string): Promise<GitCollectorData['diff']> {
        const diff: GitCollectorData['diff'] = {
            stagedChanges: '',
            unstagedChanges: '',
            conflictFiles: []
        };

        try {
            // Get staged changes
            diff.stagedChanges = await this.getStagedDiffFromCommand(workspacePath);

            // Get unstaged changes
            diff.unstagedChanges = await this.getUnstagedDiffFromCommand(workspacePath);

            // Get conflict files
            try {
                const conflictResult = await this.executeGitCommand({
                    command: 'git',
                    args: ['diff', '--name-only', '--diff-filter=U'],
                    cwd: workspacePath
                });

                if (conflictResult.stdout.trim()) {
                    diff.conflictFiles = conflictResult.stdout.trim().split('\n');
                }
            } catch (conflictError) {
                this.debug(`Failed to get conflict files: ${conflictError}`);
            }

        } catch (error) {
            this.debug(`Failed to get diff info: ${error}`);
        }

        return diff;
    }

    /**
     * Get staged diff using git command
     */
    private async getStagedDiffFromCommand(workspacePath: string): Promise<string> {
        try {
            const result = await this.executeGitCommand({
                command: 'git',
                args: ['diff', '--cached', '--name-status'],
                cwd: workspacePath
            });

            if (!result.stdout.trim()) {
                return '';
            }

            // Get detailed diff for staged files
            const detailedResult = await this.executeGitCommand({
                command: 'git',
                args: ['diff', '--cached', '--unified=3'],
                cwd: workspacePath
            });

            return this.truncateDiff(detailedResult.stdout, this.config.options.maxDiffLines || 1000);
        } catch (error) {
            this.debug(`Failed to get staged diff: ${error}`);
            return '';
        }
    }

    /**
     * Get unstaged diff using git command
     */
    private async getUnstagedDiffFromCommand(workspacePath: string): Promise<string> {
        try {
            const result = await this.executeGitCommand({
                command: 'git',
                args: ['diff', '--name-status'],
                cwd: workspacePath
            });

            if (!result.stdout.trim()) {
                return '';
            }

            // Get detailed diff for unstaged files
            const detailedResult = await this.executeGitCommand({
                command: 'git',
                args: ['diff', '--unified=3'],
                cwd: workspacePath
            });

            return this.truncateDiff(detailedResult.stdout, this.config.options.maxDiffLines || 1000);
        } catch (error) {
            this.debug(`Failed to get unstaged diff: ${error}`);
            return '';
        }
    }

    /**
     * Get branch information including ahead/behind status
     */
    private async getBranchInfo(workspacePath: string): Promise<GitCollectorData['history']['branchInfo']> {
        const branchInfo: GitCollectorData['history']['branchInfo'] = {
            ahead: 0,
            behind: 0
        };

        try {
            // Get upstream branch
            try {
                const upstreamResult = await this.executeGitCommand({
                    command: 'git',
                    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
                    cwd: workspacePath
                });
                branchInfo.upstreamBranch = upstreamResult.stdout.trim();

                // Get ahead/behind count
                const countResult = await this.executeGitCommand({
                    command: 'git',
                    args: ['rev-list', '--count', '--left-right', 'HEAD...@{u}'],
                    cwd: workspacePath
                });

                const counts = countResult.stdout.trim().split('\t');
                if (counts.length === 2) {
                    branchInfo.ahead = parseInt(counts[0], 10) || 0;
                    branchInfo.behind = parseInt(counts[1], 10) || 0;
                }

            } catch {
                // No upstream branch
                this.debug('No upstream branch found');
            }

        } catch (error) {
            this.debug(`Failed to get branch info: ${error}`);
        }

        return branchInfo;
    }

    /**
     * Parse git log output
     */
    private async parseGitLog(output: string): Promise<GitCommitInfo[]> {
        const commits: GitCommitInfo[] = [];
        const entries = output.split('\0\0').filter(entry => entry.trim());

        for (const entry of entries) {
            try {
                const lines = entry.split('\0');
                if (lines.length === 0) continue;

                const commitLine = lines[0];
                const filenames = lines.slice(1).filter(line => line.trim());

                const parts = commitLine.split('|');
                if (parts.length < 6) continue;

                const commit: GitCommitInfo = {
                    hash: parts[0],
                    shortHash: parts[1],
                    message: parts[2],
                    author: parts[3],
                    authorEmail: parts[4],
                    date: new Date(parseInt(parts[5], 10) * 1000),
                    filesChanged: filenames,
                    insertions: 0,
                    deletions: 0
                };

                // Get insertion/deletion stats for this commit
                try {
                    const statsResult = await this.executeGitCommand({
                        command: 'git',
                        args: ['show', '--stat', '--format=', commit.hash],
                        cwd: this.getWorkspacePath()
                    });

                    const stats = this.parseGitStats(statsResult.stdout);
                    commit.insertions = stats.insertions;
                    commit.deletions = stats.deletions;
                } catch {
                    // Stats not available
                }

                commits.push(commit);
            } catch (error) {
                this.debug(`Failed to parse commit entry: ${error}`);
            }
        }

        return commits;
    }

    /**
     * Parse git status code
     */
    private parseGitStatus(statusCode: string): string {
        const codes: Record<string, string> = {
            'M ': 'modified-staged',
            ' M': 'modified-unstaged',
            'MM': 'modified-both',
            'A ': 'added',
            'D ': 'deleted-staged',
            ' D': 'deleted-unstaged',
            'R ': 'renamed',
            'C ': 'copied',
            'U ': 'unmerged',
            '??': 'untracked'
        };

        return codes[statusCode] || `unknown-${statusCode}`;
    }

    /**
     * Get file diff statistics
     */
    private async getFileDiffStats(workspacePath: string, filePath: string): Promise<{ insertions: number; deletions: number }> {
        try {
            const result = await this.executeGitCommand({
                command: 'git',
                args: ['diff', '--numstat', 'HEAD', '--', filePath],
                cwd: workspacePath
            });

            const lines = result.stdout.trim().split('\n');
            if (lines.length > 0 && lines[0]) {
                const parts = lines[0].split('\t');
                if (parts.length >= 2) {
                    return {
                        insertions: parseInt(parts[0], 10) || 0,
                        deletions: parseInt(parts[1], 10) || 0
                    };
                }
            }
        } catch {
            // Fallback to simple diff
            try {
                const diffResult = await this.executeGitCommand({
                    command: 'git',
                    args: ['diff', 'HEAD', '--', filePath],
                    cwd: workspacePath
                });

                return this.countDiffLines(diffResult.stdout);
            } catch {
                // Unable to get stats
            }
        }

        return { insertions: 0, deletions: 0 };
    }

    /**
     * Parse git stats output
     */
    private parseGitStats(output: string): { insertions: number; deletions: number } {
        let insertions = 0;
        let deletions = 0;

        const lines = output.split('\n');
        for (const line of lines) {
            if (line.includes('insertion')) {
                const match = line.match(/(\d+) insertion/);
                if (match) {
                    insertions += parseInt(match[1], 10);
                }
            }
            if (line.includes('deletion')) {
                const match = line.match(/(\d+) deletion/);
                if (match) {
                    deletions += parseInt(match[1], 10);
                }
            }
        }

        return { insertions, deletions };
    }

    /**
     * Count diff lines manually
     */
    private countDiffLines(diff: string): { insertions: number; deletions: number } {
        const lines = diff.split('\n');
        let insertions = 0;
        let deletions = 0;

        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                insertions++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                deletions++;
            }
        }

        return { insertions, deletions };
    }

    /**
     * Truncate diff output to prevent memory issues
     */
    private truncateDiff(diff: string, maxLines: number): string {
        const lines = diff.split('\n');
        if (lines.length <= maxLines) {
            return diff;
        }

        const truncated = lines.slice(0, maxLines);
        truncated.push(`\n... (truncated, ${lines.length - maxLines} more lines)`);
        return truncated.join('\n');
    }

    /**
     * Execute git command
     */
    private async executeGitCommand(cmd: GitCommand): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = cp.spawn(cmd.command, cmd.args, {
                cwd: cmd.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32'
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    reject(new Error(`Git command failed with code ${code}: ${stderr}`));
                }
            });

            child.on('error', (error) => {
                reject(error);
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                child.kill();
                reject(new Error('Git command timed out'));
            }, 30000);
        });
    }
} 