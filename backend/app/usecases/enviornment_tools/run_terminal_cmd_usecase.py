import asyncio
from typing import Any, Dict, Optional
from backend.app.config.settings import settings


class RunTerminalCmdUsecase:
    def __init__(self):
        pass

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
