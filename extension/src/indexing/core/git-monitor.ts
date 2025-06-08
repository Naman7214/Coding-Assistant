import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export class GitMonitor {
    private workspacePath: string;
    private currentBranch: string | null = null;
    private disposables: vscode.Disposable[] = [];
    private onBranchChangeCallback?: (newBranch: string, oldBranch: string) => void;

    constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
    }

    /**
     * Initialize Git monitoring
     */
    async initialize(): Promise<void> {
        try {
            // Get initial branch
            this.currentBranch = await this.getCurrentBranch();

            // Set up file system watcher for .git/HEAD (branch changes)
            this.setupGitWatcher();

            // Set up periodic check as fallback
            this.setupPeriodicCheck();

        } catch (error) {
            console.warn('Git monitoring initialization failed:', error);
            // Continue without git monitoring
        }
    }

    /**
     * Set callback for branch changes
     */
    onBranchChange(callback: (newBranch: string, oldBranch: string) => void): void {
        this.onBranchChangeCallback = callback;
    }

    /**
     * Get current Git branch
     */
    async getCurrentBranch(): Promise<string> {
        try {
            const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
                cwd: this.workspacePath
            });
            return stdout.trim() || 'default';
        } catch (error) {
            // No git repository or other error
            return 'default';
        }
    }

    /**
     * Check if workspace is a Git repository
     */
    async isGitRepository(): Promise<boolean> {
        try {
            await execAsync('git rev-parse --git-dir', {
                cwd: this.workspacePath
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get Git status information
     */
    async getGitStatus(): Promise<{
        branch: string;
        hasUncommittedChanges: boolean;
        lastCommitHash: string;
        lastCommitDate: Date;
    }> {
        try {
            const branch = await this.getCurrentBranch();

            // Check for uncommitted changes
            const { stdout: statusOutput } = await execAsync('git status --porcelain', {
                cwd: this.workspacePath
            });
            const hasUncommittedChanges = statusOutput.trim().length > 0;

            // Get last commit info
            const { stdout: commitInfo } = await execAsync('git log -1 --format="%H|%ci"', {
                cwd: this.workspacePath
            });
            const [lastCommitHash, lastCommitDate] = commitInfo.trim().replace(/"/g, '').split('|');

            return {
                branch,
                hasUncommittedChanges,
                lastCommitHash,
                lastCommitDate: new Date(lastCommitDate)
            };
        } catch (error) {
            // Return default values for non-git repositories
            return {
                branch: 'default',
                hasUncommittedChanges: false,
                lastCommitHash: '',
                lastCommitDate: new Date()
            };
        }
    }

    /**
     * Set up file system watcher for Git HEAD changes
     */
    private setupGitWatcher(): void {
        try {
            const gitHeadPath = path.join(this.workspacePath, '.git', 'HEAD');
            const gitRefsPath = path.join(this.workspacePath, '.git', 'refs');

            // Watch .git/HEAD for branch switches
            const headWatcher = vscode.workspace.createFileSystemWatcher(gitHeadPath);

            headWatcher.onDidChange(async () => {
                await this.checkForBranchChange();
            });

            // Watch .git/refs for new branches and commits
            const refsWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(gitRefsPath, '**/*')
            );

            refsWatcher.onDidChange(async () => {
                await this.checkForBranchChange();
            });

            refsWatcher.onDidCreate(async () => {
                await this.checkForBranchChange();
            });

            this.disposables.push(headWatcher, refsWatcher);

        } catch (error) {
            console.warn('Failed to setup Git file watchers:', error);
        }
    }

    /**
     * Set up periodic branch checking as fallback
     */
    private setupPeriodicCheck(): void {
        const checkInterval = setInterval(async () => {
            await this.checkForBranchChange();
        }, 30000); // Check every 30 seconds

        this.disposables.push({
            dispose: () => clearInterval(checkInterval)
        });
    }

    /**
     * Check if branch has changed and notify callback
     */
    private async checkForBranchChange(): Promise<void> {
        try {
            const newBranch = await this.getCurrentBranch();

            if (this.currentBranch && newBranch !== this.currentBranch) {
                const oldBranch = this.currentBranch;
                this.currentBranch = newBranch;

                if (this.onBranchChangeCallback) {
                    this.onBranchChangeCallback(newBranch, oldBranch);
                }

                console.log(`Git branch changed from ${oldBranch} to ${newBranch}`);
            } else if (!this.currentBranch) {
                this.currentBranch = newBranch;
            }
        } catch (error) {
            console.warn('Error checking for branch change:', error);
        }
    }

    /**
     * Get list of changed files since last commit
     */
    async getChangedFilesSinceCommit(): Promise<string[]> {
        try {
            const { stdout } = await execAsync('git diff --name-only HEAD', {
                cwd: this.workspacePath
            });

            return stdout
                .trim()
                .split('\n')
                .filter(file => file.length > 0)
                .map(file => path.resolve(this.workspacePath, file));
        } catch (error) {
            return [];
        }
    }

    /**
     * Get list of files changed between branches
     */
    async getChangedFilesBetweenBranches(fromBranch: string, toBranch: string): Promise<string[]> {
        try {
            const { stdout } = await execAsync(`git diff --name-only ${fromBranch}..${toBranch}`, {
                cwd: this.workspacePath
            });

            return stdout
                .trim()
                .split('\n')
                .filter(file => file.length > 0)
                .map(file => path.resolve(this.workspacePath, file));
        } catch (error) {
            return [];
        }
    }

    /**
     * Dispose of all watchers and timers
     */
    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
    }
} 