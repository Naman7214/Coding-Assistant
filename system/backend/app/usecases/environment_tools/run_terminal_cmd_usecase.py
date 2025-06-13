import re
from typing import Any, Dict, List, Optional, Pattern, Set, Tuple

from fastapi import Depends

from system.backend.app.services.terminal_client_service import (
    TerminalClientService,
)


class RunTerminalCmdUsecase:
    def __init__(self, terminal_client: TerminalClientService = Depends()):
        self.terminal_client = terminal_client

        # Explicitly blocked commands
        self.BLOCKED_COMMANDS: Set[str] = {
            "rm -rf /",
            "rm -rf /*",
            "rm -rf --no-preserve-root /",
            ":(){ :|:& };:",
            "crontab -r",
        }

        # Dangerous command patterns to detect
        self.DANGEROUS_PATTERNS: List[Tuple[Pattern, str]] = [
            # Data destruction patterns
            (
                re.compile(r"rm\s+-r?f\s+(/|/\*|/\.\.|--no-preserve-root)"),
                "File system deletion",
            ),
            (
                re.compile(
                    r"dd\s+if=/dev/(zero|random|urandom)\s+of=/dev/([sh]d[a-z]|nvme|xvd)"
                ),
                "Disk overwrite",
            ),
            (
                re.compile(r"mkfs\.[a-z0-9]+\s+/dev/([sh]d[a-z]|nvme|xvd)"),
                "Disk formatting",
            ),
            (re.compile(r"mv\s+.*\s+/dev/null"), "Data deletion via /dev/null"),
            (re.compile(r">\s+/dev/([sh]d[a-z]|nvme|xvd)"), "Disk corruption"),
            (re.compile(r"shred\s+.*\s+-z"), "Secure data deletion"),
            # System destabilization patterns
            (re.compile(r":\(\)\s*{\s*:\|:"), "Fork bomb detection"),
            (re.compile(r"kill\s+-9\s+-1"), "Killing all processes"),
            (re.compile(r"shutdown\s+(-h|-r)\s+now"), "System shutdown"),
            (
                re.compile(r"systemctl\s+(poweroff|halt|reboot)"),
                "System power management",
            ),
            # Permission and security compromise
            (
                re.compile(r"chmod\s+-R\s+777\s+/"),
                "Recursive permission change",
            ),
            (
                re.compile(r"chmod\s+.*\s+/etc/sudoers"),
                "Sudoers file modification",
            ),
            (re.compile(r"passwd\s+root"), "Root password change"),
            # Remote execution vulnerabilities
            (
                re.compile(r"wget\s+.*\s+\|\s+([sb]a)?sh"),
                "Piping web content to shell",
            ),
            (
                re.compile(r"curl\s+.*\s+\|\s+([sb]a)?sh"),
                "Piping web content to shell",
            ),
            # File system manipulation
            (
                re.compile(r"find\s+/\s+-type\s+[fd]\s+-exec\s+.*\s+\{\}"),
                "Dangerous find command",
            ),
            (re.compile(r"find\s+/\s+.*\s+-delete"), "Dangerous find deletion"),
            # Disk usage filling
            (
                re.compile(r"fallocate\s+-l\s+\d+[GT]\s+"),
                "Large file allocation",
            ),
            (re.compile(r"base64\s+/dev/urandom"), "Random data generation"),
            # Network command abuse
            (
                re.compile(r"nc\s+-e\s+/bin/([sb]a)?sh"),
                "Netcat shell execution",
            ),
            (
                re.compile(r"telnet\s+.*\s+\|\s+/bin/([sb]a)?sh"),
                "Telnet shell piping",
            ),
        ]

    async def run_terminal_command(
        self,
        command: str,
        is_background: bool,
        explanation: Optional[str] = None,
        workspace_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Run a terminal command using the client-side terminal API.

        Args:
            command: The terminal command to execute
            is_background: Whether the command should be run in the background
            explanation: Explanation for why the command is needed
            workspace_path: The workspace path

        Returns:
            A dictionary with the command output and execution status
        """
        try:
            # Security check for dangerous commands
            security_check = self._check_command_safety(command)
            if security_check["is_dangerous"]:
                return {
                    "output": "",
                    "error": f"SECURITY ALERT: Dangerous command detected. {security_check['reason']}",
                    "exit_code": 1,
                    "status": "blocked_dangerous_command",
                    "current_directory": workspace_path or "/",
                }

            # Log command and explanation if provided
            if explanation:
                print(f"Explanation: {explanation}")

            print(f"Executing command: {command}")
            print(f"Run in background: {is_background}")

            # Execute command using client-side terminal API
            result = await self.terminal_client.execute_terminal_command(
                command=command,
                workspace_path=workspace_path or "/",
                is_background=is_background,
                timeout=(
                    300000 if not is_background else None
                ),  # Extension expects timeout in milliseconds, not seconds
                silent=False,  # Always show run_terminal_cmd commands in terminal
            )

            # Map client response to expected format
            return {
                "output": result.get("output", ""),
                "error": result.get("error", ""),
                "exit_code": result.get("exitCode"),
                "status": self._map_client_status(
                    result.get("status", "unknown"), is_background
                ),
                "current_directory": result.get(
                    "currentDirectory", workspace_path or "/"
                ),
            }

        except Exception as e:
            error_msg = f"Error executing command: {str(e)}"
            print(error_msg)
            return {
                "output": "",
                "error": error_msg,
                "exit_code": 1,
                "status": "error",
                "current_directory": workspace_path or "/",
            }

    def _map_client_status(
        self, client_status: str, is_background: bool
    ) -> str:
        """Map client API status to expected status format."""
        status_mapping = {
            "completed": "completed",
            "error": "error",
            "timeout": "timeout",
            "running_in_background": "running_in_background",
        }

        mapped_status = status_mapping.get(client_status, "error")

        # For background commands, override status if needed
        if is_background and mapped_status == "completed":
            return "running_in_background"

        return mapped_status

    def _check_command_safety(self, command: str) -> Dict[str, Any]:
        """
        Check if the command is potentially dangerous.

        Args:
            command: The command to check

        Returns:
            Dictionary with is_dangerous flag and reason if dangerous
        """
        # Normalize command for better matching (lowercase, remove extra spaces)
        normalized_cmd = re.sub(r"\s+", " ", command.strip().lower())

        # Check against explicitly blocked commands
        for blocked_cmd in self.BLOCKED_COMMANDS:
            if blocked_cmd in normalized_cmd:
                return {
                    "is_dangerous": True,
                    "reason": f"Blocked command detected: '{blocked_cmd}'",
                }

        # Check against dangerous patterns
        for pattern, description in self.DANGEROUS_PATTERNS:
            if pattern.search(normalized_cmd):
                return {
                    "is_dangerous": True,
                    "reason": f"Dangerous operation detected: {description}",
                }

        # Look for sudo usages with dangerous commands
        if "sudo" in normalized_cmd:
            # Re-check the command without sudo to catch sudo-prefixed dangerous commands
            cmd_without_sudo = re.sub(r"^sudo\s+", "", normalized_cmd)
            sudo_check = self._check_command_safety(cmd_without_sudo)
            if sudo_check["is_dangerous"]:
                return {
                    "is_dangerous": True,
                    "reason": f"Privileged dangerous operation detected: {sudo_check['reason']}",
                }

        # Check for chained commands that might be dangerous
        if any(x in normalized_cmd for x in [";", "&&", "||", "|"]):
            # Split and check each part of chained commands
            separators = [";", "&&", "||"]
            parts = normalized_cmd
            for sep in separators:
                parts = " ".join(parts.split(sep))

            chained_commands = [p.strip() for p in parts.split() if p.strip()]
            for cmd_part in chained_commands:
                part_check = self._check_command_safety(cmd_part)
                if part_check["is_dangerous"]:
                    return {
                        "is_dangerous": True,
                        "reason": f"Dangerous operation in command chain: {part_check['reason']}",
                    }

        return {
            "is_dangerous": False,
            "reason": None,
        }
