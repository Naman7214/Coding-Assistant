import asyncio
import re
from typing import Any, Dict, List, Optional, Pattern, Set, Tuple
from backend.app.config.settings import settings


class RunTerminalCmdUsecase:
    def __init__(self):
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
            (re.compile(r"rm\s+-r?f\s+(/|/\*|/\.\.|--no-preserve-root)"), "File system deletion"),
            (re.compile(r"dd\s+if=/dev/(zero|random|urandom)\s+of=/dev/([sh]d[a-z]|nvme|xvd)"), "Disk overwrite"),
            (re.compile(r"mkfs\.[a-z0-9]+\s+/dev/([sh]d[a-z]|nvme|xvd)"), "Disk formatting"),
            (re.compile(r"mv\s+.*\s+/dev/null"), "Data deletion via /dev/null"),
            (re.compile(r">\s+/dev/([sh]d[a-z]|nvme|xvd)"), "Disk corruption"),
            (re.compile(r"shred\s+.*\s+-z"), "Secure data deletion"),
            
            # System destabilization patterns
            (re.compile(r":\(\)\s*{\s*:\|:"), "Fork bomb detection"),
            (re.compile(r"kill\s+-9\s+-1"), "Killing all processes"),
            (re.compile(r"shutdown\s+(-h|-r)\s+now"), "System shutdown"),
            (re.compile(r"systemctl\s+(poweroff|halt|reboot)"), "System power management"),
            
            # Permission and security compromise
            (re.compile(r"chmod\s+-R\s+777\s+/"), "Recursive permission change"),
            (re.compile(r"chmod\s+.*\s+/etc/sudoers"), "Sudoers file modification"),
            (re.compile(r"passwd\s+root"), "Root password change"),
            
            # Remote execution vulnerabilities
            (re.compile(r"wget\s+.*\s+\|\s+([sb]a)?sh"), "Piping web content to shell"),
            (re.compile(r"curl\s+.*\s+\|\s+([sb]a)?sh"), "Piping web content to shell"),
            
            # File system manipulation
            (re.compile(r"find\s+/\s+-type\s+[fd]\s+-exec\s+.*\s+\{\}"), "Dangerous find command"),
            (re.compile(r"find\s+/\s+.*\s+-delete"), "Dangerous find deletion"),
            
            # Disk usage filling
            (re.compile(r"fallocate\s+-l\s+\d+[GT]\s+"), "Large file allocation"),
            (re.compile(r"base64\s+/dev/urandom"), "Random data generation"),
            
            # Network command abuse
            (re.compile(r"nc\s+-e\s+/bin/([sb]a)?sh"), "Netcat shell execution"),
            (re.compile(r"telnet\s+.*\s+\|\s+/bin/([sb]a)?sh"), "Telnet shell piping"),
        ]

    async def run_terminal_command(
        self,
        command: str,
        is_background: bool,
        explanation: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Run a terminal command on the user's system.

        Args:
            command: The terminal command to execute
            is_background: Whether the command should be run in the background
            explanation: Explanation for why the command is needed

        Returns:
            A dictionary with the command output and execution status
        """
        import subprocess
        
        try:
            # Security check for dangerous commands
            security_check = self._check_command_safety(command)
            if security_check["is_dangerous"]:
                return {
                    "output": "",
                    "error": f"SECURITY ALERT: Dangerous command detected. {security_check['reason']}",
                    "exit_code": 1,
                    "status": "blocked_dangerous_command",
                }
                
            # Log command and explanation if provided
            if explanation:
                print(f"Explanation: {explanation}")

            print(f"Executing command: {command}")
            print(f"Run in background: {is_background}")

            if is_background:
                # For background processes, use Popen and don't wait
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    start_new_session=True,
                    cwd=settings.CODEBASE_DIR,  # Set working directory to CODEBASE_DIR
                    shell=True,  # Use shell to expand wildcards, variables, etc.
                )
                return {
                    "output": f"Command started in background with PID {process.pid}",
                    "exit_code": None,
                    "status": "running_in_background",
                }
            else:
                # For foreground processes, capture output
                process = await asyncio.create_subprocess_shell(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=settings.CODEBASE_DIR,  # Set working directory to CODEBASE_DIR
                )

                stdout, stderr = await process.communicate()
                stdout_str = stdout.decode("utf-8")
                stderr_str = stderr.decode("utf-8")

                return {
                    "output": stdout_str,
                    "error": stderr_str,
                    "exit_code": process.returncode,
                    "status": (
                        "completed" if process.returncode == 0 else "error"
                    ),
                }

                # FALLBACK IF THE ABOVE ASYNCIO CODE FAILS UNCOMMENT THIS AND COMMENT THE ABOVE CODE
                # result = subprocess.run(
                #     shlex.split(command),
                #     capture_output=True,
                #     text=True,
                #     timeout=60  # Add reasonable timeout
                # )

                # return {
                #     "output": result.stdout,
                #     "error": result.stderr,
                #     "exit_code": result.returncode,
                #     "status": "completed" if result.returncode == 0 else "error"
                # }

        except subprocess.TimeoutExpired:
            return {
                "output": "Command timed out after 60 seconds",
                "exit_code": None,
                "status": "timeout",
            }
        except Exception as e:
            error_msg = f"Error executing command: {str(e)}"
            print(error_msg)
            return {
                "output": "",
                "error": error_msg,
                "exit_code": 1,
                "status": "error",
            }
            
    def _check_command_safety(self, command: str) -> Dict[str, Any]:
        """
        Check if the command is potentially dangerous.
        
        Args:
            command: The command to check
            
        Returns:
            Dictionary with is_dangerous flag and reason if dangerous
        """
        # Normalize command for better matching (lowercase, remove extra spaces)
        normalized_cmd = re.sub(r'\s+', ' ', command.strip().lower())
        
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
            cmd_without_sudo = re.sub(r'^sudo\s+', '', normalized_cmd)
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
