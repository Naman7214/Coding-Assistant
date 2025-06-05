import * as vscode from 'vscode';

interface TerminalSession {
    terminal: vscode.Terminal;
    workspacePath: string;
    currentDirectory: string;
    sessionId: string;
    lastUsed: number;
    shellIntegration?: vscode.TerminalShellIntegration;
    environmentVariables: Map<string, string>;
    isReady: boolean;
}

interface CommandExecution {
    command: string;
    workingDirectory?: string;
    environmentVariables?: Record<string, string>;
    isBackground?: boolean;
    timeout?: number;
}

interface CommandResult {
    output: string;
    error: string;
    exitCode: number | null;
    status: 'completed' | 'error' | 'timeout' | 'running_in_background';
    command: string;
    workingDirectory: string;
    duration: number;
}

export class PersistentTerminalManager implements vscode.Disposable {
    private terminals: Map<string, TerminalSession> = new Map();
    private outputChannel: vscode.OutputChannel;
    private disposables: vscode.Disposable[] = [];
    private readonly TERMINAL_TIMEOUT = 30000; // 30 seconds default timeout
    private readonly FIXED_PORT = 8080; // Fixed port as requested

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        // Monitor terminal shell integration changes
        this.disposables.push(
            vscode.window.onDidChangeTerminalShellIntegration(({ terminal, shellIntegration }) => {
                const session = this.findSessionByTerminal(terminal);
                if (session) {
                    session.shellIntegration = shellIntegration;
                    session.isReady = true;
                    this.outputChannel.appendLine(`[TerminalManager] Shell integration ready for workspace: ${session.workspacePath}`);
                }
            })
        );

        // Monitor terminal closures
        this.disposables.push(
            vscode.window.onDidCloseTerminal((terminal) => {
                const session = this.findSessionByTerminal(terminal);
                if (session) {
                    this.outputChannel.appendLine(`[TerminalManager] Terminal closed for workspace: ${session.workspacePath}`);
                    this.terminals.delete(session.workspacePath);
                }
            })
        );

        // Monitor workspace folder changes
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders((event) => {
                // Clean up terminals for removed workspaces
                for (const removed of event.removed) {
                    const session = this.terminals.get(removed.uri.fsPath);
                    if (session) {
                        session.terminal.dispose();
                        this.terminals.delete(removed.uri.fsPath);
                        this.outputChannel.appendLine(`[TerminalManager] Cleaned up terminal for removed workspace: ${removed.uri.fsPath}`);
                    }
                }
            })
        );
    }

    private findSessionByTerminal(terminal: vscode.Terminal): TerminalSession | undefined {
        for (const session of this.terminals.values()) {
            if (session.terminal === terminal) {
                return session;
            }
        }
        return undefined;
    }

    /**
     * Get or create a persistent terminal session for a workspace
     */
    public async getOrCreateSession(workspacePath: string): Promise<TerminalSession> {
        let session = this.terminals.get(workspacePath);

        if (!session || session.terminal.exitStatus) {
            // Create new terminal session
            session = await this.createNewSession(workspacePath);
            this.terminals.set(workspacePath, session);
        }

        session.lastUsed = Date.now();
        return session;
    }

    private async createNewSession(workspacePath: string): Promise<TerminalSession> {
        const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Get system information for shell configuration
        const platform = process.platform;
        let shellPath: string;

        // Use VS Code's configured shell
        const config = vscode.workspace.getConfiguration();
        if (platform === 'win32') {
            shellPath = config.get('terminal.integrated.shell.windows') ||
                config.get('terminal.integrated.defaultProfile.windows') ||
                process.env.COMSPEC || 'cmd.exe';
        } else if (platform === 'darwin') {
            shellPath = config.get('terminal.integrated.shell.osx') ||
                config.get('terminal.integrated.defaultProfile.osx') ||
                process.env.SHELL || '/bin/zsh';
        } else {
            shellPath = config.get('terminal.integrated.shell.linux') ||
                config.get('terminal.integrated.defaultProfile.linux') ||
                process.env.SHELL || '/bin/bash';
        }

        const terminal = vscode.window.createTerminal({
            name: `Bridge Terminal - ${workspacePath.split('/').pop()}`,
            cwd: workspacePath,
            shellPath: shellPath,
            env: {
                ...process.env,
                'VSCODE_BRIDGE_SESSION': sessionId,
                'VSCODE_WORKSPACE_PATH': workspacePath
            }
        });

        const session: TerminalSession = {
            terminal,
            workspacePath,
            currentDirectory: workspacePath,
            sessionId,
            lastUsed: Date.now(),
            environmentVariables: new Map(),
            isReady: false
        };

        this.outputChannel.appendLine(`[TerminalManager] Created new terminal session for workspace: ${workspacePath}`);

        // Wait for shell integration to be ready
        await this.waitForShellIntegration(session);

        return session;
    }

    private async waitForShellIntegration(session: TerminalSession): Promise<void> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.outputChannel.appendLine(`[TerminalManager] Shell integration timeout for ${session.workspacePath}, using fallback`);
                session.isReady = true;
                resolve();
            }, 5000);

            const checkIntegration = () => {
                if (session.terminal.shellIntegration) {
                    clearTimeout(timeout);
                    session.shellIntegration = session.terminal.shellIntegration;
                    session.isReady = true;
                    this.outputChannel.appendLine(`[TerminalManager] Shell integration ready for ${session.workspacePath}`);
                    resolve();
                } else {
                    setTimeout(checkIntegration, 100);
                }
            };

            checkIntegration();
        });
    }

    /**
     * Execute a command in the persistent terminal session
     */
    public async executeCommand(
        workspacePath: string,
        execution: CommandExecution
    ): Promise<CommandResult> {
        const startTime = Date.now();
        const session = await this.getOrCreateSession(workspacePath);

        try {
            this.outputChannel.appendLine(
                `[TerminalManager] Executing command in ${workspacePath}: ${execution.command}`
            );

            // Update working directory if needed
            if (execution.workingDirectory && execution.workingDirectory !== session.currentDirectory) {
                await this.changeDirectory(session, execution.workingDirectory);
            }

            // Set environment variables if provided
            if (execution.environmentVariables) {
                await this.setEnvironmentVariables(session, execution.environmentVariables);
            }

            // Execute the command
            if (execution.isBackground) {
                return await this.executeBackgroundCommand(session, execution, startTime);
            } else {
                return await this.executeInteractiveCommand(session, execution, startTime);
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            this.outputChannel.appendLine(`[TerminalManager] Command execution error: ${error}`);

            return {
                output: '',
                error: error instanceof Error ? error.message : String(error),
                exitCode: 1,
                status: 'error',
                command: execution.command,
                workingDirectory: session.currentDirectory,
                duration
            };
        }
    }

    private async changeDirectory(session: TerminalSession, newDirectory: string): Promise<void> {
        const cdCommand = process.platform === 'win32' ? `cd /d "${newDirectory}"` : `cd "${newDirectory}"`;

        if (session.shellIntegration) {
            try {
                const command = session.shellIntegration.executeCommand({
                    command: cdCommand,
                    args: []
                });
                await command.exitCode;
                session.currentDirectory = newDirectory;
                this.outputChannel.appendLine(`[TerminalManager] Changed directory to: ${newDirectory}`);
            } catch (error) {
                this.outputChannel.appendLine(`[TerminalManager] Failed to change directory: ${error}`);
            }
        } else {
            // Fallback without shell integration
            session.terminal.sendText(cdCommand);
            session.currentDirectory = newDirectory;
            // Wait a bit for command to execute
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    private async setEnvironmentVariables(
        session: TerminalSession,
        envVars: Record<string, string>
    ): Promise<void> {
        for (const [key, value] of Object.entries(envVars)) {
            if (!session.environmentVariables.has(key) || session.environmentVariables.get(key) !== value) {
                const setCommand = process.platform === 'win32'
                    ? `set ${key}=${value}`
                    : `export ${key}="${value}"`;

                if (session.shellIntegration) {
                    try {
                        const command = session.shellIntegration.executeCommand({
                            command: setCommand,
                            args: []
                        });
                        await command.exitCode;
                        session.environmentVariables.set(key, value);
                    } catch (error) {
                        this.outputChannel.appendLine(`[TerminalManager] Failed to set env var ${key}: ${error}`);
                    }
                } else {
                    session.terminal.sendText(setCommand);
                    session.environmentVariables.set(key, value);
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }
    }

    private async executeBackgroundCommand(
        session: TerminalSession,
        execution: CommandExecution,
        startTime: number
    ): Promise<CommandResult> {
        const duration = Date.now() - startTime;

        // For background commands, just send the text and return immediately
        session.terminal.sendText(execution.command);

        return {
            output: `Command started in background: ${execution.command}`,
            error: '',
            exitCode: null,
            status: 'running_in_background',
            command: execution.command,
            workingDirectory: session.currentDirectory,
            duration
        };
    }

    private async executeInteractiveCommand(
        session: TerminalSession,
        execution: CommandExecution,
        startTime: number
    ): Promise<CommandResult> {
        const timeout = execution.timeout || this.TERMINAL_TIMEOUT;

        if (session.shellIntegration) {
            try {
                // Use shell integration for reliable command execution
                const command = session.shellIntegration.executeCommand({
                    command: execution.command,
                    args: []
                });

                // Wait for command completion with timeout
                const exitCode = await Promise.race([
                    command.exitCode,
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('Command timeout')), timeout)
                    )
                ]);

                const duration = Date.now() - startTime;

                return {
                    output: `Command executed successfully: ${execution.command}`,
                    error: '',
                    exitCode: exitCode,
                    status: exitCode === 0 ? 'completed' : 'error',
                    command: execution.command,
                    workingDirectory: session.currentDirectory,
                    duration
                };

            } catch (error) {
                const duration = Date.now() - startTime;
                const isTimeout = error instanceof Error && error.message === 'Command timeout';

                return {
                    output: '',
                    error: error instanceof Error ? error.message : String(error),
                    exitCode: isTimeout ? null : 1,
                    status: isTimeout ? 'timeout' : 'error',
                    command: execution.command,
                    workingDirectory: session.currentDirectory,
                    duration
                };
            }
        } else {
            // Fallback without shell integration
            session.terminal.sendText(execution.command);
            const duration = Date.now() - startTime;

            return {
                output: `Command sent to terminal (no shell integration): ${execution.command}`,
                error: '',
                exitCode: null,
                status: 'completed',
                command: execution.command,
                workingDirectory: session.currentDirectory,
                duration
            };
        }
    }

    /**
     * Get current status of all terminal sessions
     */
    public getSessionsStatus(): Record<string, any> {
        const status: Record<string, any> = {};

        for (const [workspacePath, session] of this.terminals.entries()) {
            status[workspacePath] = {
                sessionId: session.sessionId,
                isReady: session.isReady,
                hasShellIntegration: !!session.shellIntegration,
                currentDirectory: session.currentDirectory,
                lastUsed: new Date(session.lastUsed).toISOString(),
                isActive: !session.terminal.exitStatus
            };
        }

        return status;
    }

    /**
     * Clean up inactive sessions (older than 1 hour)
     */
    public cleanupInactiveSessions(): void {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);

        for (const [workspacePath, session] of this.terminals.entries()) {
            if (session.lastUsed < oneHourAgo || session.terminal.exitStatus) {
                session.terminal.dispose();
                this.terminals.delete(workspacePath);
                this.outputChannel.appendLine(`[TerminalManager] Cleaned up inactive session for: ${workspacePath}`);
            }
        }
    }

    public dispose(): void {
        // Dispose all terminals
        for (const session of this.terminals.values()) {
            session.terminal.dispose();
        }
        this.terminals.clear();

        // Dispose event listeners
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];

        this.outputChannel.appendLine('[TerminalManager] Disposed all terminal sessions');
    }
} 