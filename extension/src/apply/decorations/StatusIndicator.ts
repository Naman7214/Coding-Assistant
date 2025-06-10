import * as vscode from 'vscode';
import { StatusBarState } from '../types/apply.types';

export class StatusIndicator {
    private statusBarItem: vscode.StatusBarItem;
    private isVisible: boolean = false;
    private hideTimeout: NodeJS.Timeout | null = null;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100 // Priority - higher numbers appear more to the left
        );

        this.statusBarItem.command = 'coding-agent.showApplyStatus';
        this.statusBarItem.tooltip = 'Code Apply Status';
    }

    /**
     * Show the status indicator with message and icon
     */
    show(message: string, icon?: string, tooltip?: string): void {
        this.clearHideTimeout();

        const iconPrefix = icon ? `$(${icon}) ` : '';
        this.statusBarItem.text = `${iconPrefix}${message}`;

        if (tooltip) {
            this.statusBarItem.tooltip = tooltip;
        }

        if (!this.isVisible) {
            this.statusBarItem.show();
            this.isVisible = true;
        }
    }

    /**
     * Update the status indicator
     */
    update(message: string, icon?: string, tooltip?: string): void {
        if (this.isVisible) {
            this.show(message, icon, tooltip);
        }
    }

    /**
     * Hide the status indicator
     */
    hide(): void {
        this.clearHideTimeout();

        if (this.isVisible) {
            this.statusBarItem.hide();
            this.isVisible = false;
        }
    }

    /**
     * Show progress with percentage
     */
    showProgress(message: string, progress: number, icon: string = 'sync~spin'): void {
        const progressBar = this.createProgressBar(progress);
        const fullMessage = `${message} ${progressBar} ${progress.toFixed(0)}%`;
        this.show(fullMessage, icon, `Progress: ${progress.toFixed(1)}%`);
    }

    /**
     * Show success status
     */
    showSuccess(message: string, autoHideMs: number = 3000): void {
        this.show(message, 'check', 'Operation completed successfully');
        this.autoHide(autoHideMs);
    }

    /**
     * Show error status
     */
    showError(message: string, autoHideMs: number = 5000): void {
        this.show(message, 'error', 'Operation failed');
        this.autoHide(autoHideMs);
    }

    /**
     * Show warning status
     */
    showWarning(message: string, autoHideMs: number = 4000): void {
        this.show(message, 'warning', 'Warning occurred');
        this.autoHide(autoHideMs);
    }

    /**
     * Show info status
     */
    showInfo(message: string, autoHideMs: number = 3000): void {
        this.show(message, 'info', 'Information');
        this.autoHide(autoHideMs);
    }

    /**
     * Show streaming status with animation
     */
    showStreaming(message: string): void {
        this.show(message, 'loading~spin', 'Streaming in progress...');
    }

    /**
     * Show processing status
     */
    showProcessing(message: string, step?: number, totalSteps?: number): void {
        let fullMessage = message;
        let tooltip = 'Processing...';

        if (step !== undefined && totalSteps !== undefined) {
            fullMessage = `${message} (${step}/${totalSteps})`;
            tooltip = `Step ${step} of ${totalSteps}`;
        }

        this.show(fullMessage, 'gear~spin', tooltip);
    }

    /**
     * Show connection status
     */
    showConnection(isConnected: boolean, serverUrl?: string): void {
        if (isConnected) {
            this.show('Connected to FastAPI', 'plug', `Connected to ${serverUrl || 'server'}`);
            this.autoHide(2000);
        } else {
            this.show('Disconnected from FastAPI', 'debug-disconnect', 'Connection failed');
            this.autoHide(5000);
        }
    }

    /**
     * Show cancellation status
     */
    showCancelled(message: string = 'Operation cancelled'): void {
        this.show(message, 'stop', 'Operation was cancelled by user');
        this.autoHide(3000);
    }

    /**
     * Auto-hide after specified time
     */
    autoHide(delayMs: number): void {
        this.clearHideTimeout();
        this.hideTimeout = setTimeout(() => {
            this.hide();
        }, delayMs);
    }

    /**
     * Clear any pending hide timeout
     */
    private clearHideTimeout(): void {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    /**
     * Create a simple progress bar using Unicode characters
     */
    private createProgressBar(progress: number, width: number = 10): string {
        const filled = Math.round((progress / 100) * width);
        const empty = width - filled;

        const filledChar = '█';
        const emptyChar = '░';

        return '[' + filledChar.repeat(filled) + emptyChar.repeat(empty) + ']';
    }

    /**
     * Get current status
     */
    getStatus(): {
        isVisible: boolean;
        text: string;
        tooltip: string;
    } {
        return {
            isVisible: this.isVisible,
            text: this.statusBarItem.text,
            tooltip: typeof this.statusBarItem.tooltip === 'string' ? this.statusBarItem.tooltip : (this.statusBarItem.tooltip?.value || ''),
        };
    }

    /**
     * Set custom state
     */
    setState(state: StatusBarState): void {
        this.statusBarItem.text = state.text;
        this.statusBarItem.tooltip = state.tooltip;

        if (state.command) {
            this.statusBarItem.command = state.command;
        }

        if (state.color) {
            this.statusBarItem.color = state.color;
        }

        this.statusBarItem.show();
        this.isVisible = true;
    }

    /**
     * Toggle visibility
     */
    toggle(): void {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show('Apply Ready', 'code');
        }
    }

    /**
     * Check if currently visible
     */
    get visible(): boolean {
        return this.isVisible;
    }

    /**
     * Pulse effect for attention
     */
    pulse(message: string, count: number = 3, intervalMs: number = 500): void {
        let pulseCount = 0;
        const originalMessage = this.statusBarItem.text;

        const pulseInterval = setInterval(() => {
            if (pulseCount % 2 === 0) {
                this.show(message, 'circle-large-filled');
            } else {
                this.show(message, 'circle-large-outline');
            }

            pulseCount++;

            if (pulseCount >= count * 2) {
                clearInterval(pulseInterval);
                // Restore original message if it existed
                if (originalMessage) {
                    this.statusBarItem.text = originalMessage;
                }
            }
        }, intervalMs);
    }

    /**
     * Show with custom color
     */
    showWithColor(message: string, color: vscode.ThemeColor, icon?: string): void {
        this.show(message, icon);
        this.statusBarItem.color = color;
    }

    /**
     * Reset color to default
     */
    resetColor(): void {
        this.statusBarItem.color = undefined;
    }

    /**
     * Show countdown timer
     */
    showCountdown(message: string, seconds: number, callback?: () => void): void {
        let remaining = seconds;

        const updateCountdown = () => {
            this.show(`${message} (${remaining}s)`, 'clock');
            remaining--;

            if (remaining >= 0) {
                setTimeout(updateCountdown, 1000);
            } else {
                this.hide();
                if (callback) {
                    callback();
                }
            }
        };

        updateCountdown();
    }

    /**
     * Dispose the status bar item
     */
    dispose(): void {
        this.clearHideTimeout();
        this.statusBarItem.dispose();
    }

    /**
     * Show accept/reject buttons in status bar for diff review
     */
    showAcceptRejectButtons(
        onAccept: () => void,
        onReject: () => void
    ): vscode.Disposable[] {
        // Create accept button
        const acceptButton = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            102
        );
        acceptButton.text = '$(check) Accept';
        acceptButton.tooltip = 'Accept the AI-generated changes';
        acceptButton.command = `apply.accept.${Date.now()}`;
        acceptButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        acceptButton.show();

        // Create reject button  
        const rejectButton = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            101
        );
        rejectButton.text = '$(close) Reject';
        rejectButton.tooltip = 'Reject the AI-generated changes and restore original';
        rejectButton.command = `apply.reject.${Date.now()}`;
        rejectButton.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        rejectButton.show();

        // Register commands
        const acceptDisposable = vscode.commands.registerCommand(acceptButton.command!, () => {
            onAccept();
            acceptButton.dispose();
            rejectButton.dispose();
            acceptDisposable.dispose();
            rejectDisposable.dispose();
        });

        const rejectDisposable = vscode.commands.registerCommand(rejectButton.command!, () => {
            onReject();
            acceptButton.dispose();
            rejectButton.dispose();
            acceptDisposable.dispose();
            rejectDisposable.dispose();
        });

        return [acceptDisposable, rejectDisposable];
    }
} 