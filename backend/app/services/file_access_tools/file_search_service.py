import subprocess
from datetime import datetime
from typing import Any, Dict, List

from fastapi import Depends, HTTPException, status

from backend.app.models.domain.error import Error
from backend.app.repositories.error_repo import ErrorRepo


class FileSearchService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo

    async def search_files(
        self, pattern: str, explanation: str
    ) -> List[Dict[str, Any]]:
        try:

            current_dir = "."

            # Directories to exclude from search
            exclude_dirs = [
                ".venv",
                ".env",
                "venv",
                "env",
                "node_modules",
                "__pycache__",
                ".git",
                ".idea",
                ".vs",
                ".vscode",
                "dist",
                "build",
            ]

            # First, generate a list of files excluding the directories
            find_cmd = ["find", current_dir]

            # Add exclusion patterns
            for exclude_dir in exclude_dirs:
                find_cmd.extend(
                    [
                        "-not",
                        "-path",
                        f"*/{exclude_dir}/*",
                        "-not",
                        "-path",
                        f"*/{exclude_dir}",
                    ]
                )

            # Run find command to get filtered file list
            find_process = subprocess.run(
                find_cmd,
                stdout=subprocess.PIPE,
                text=True,
                cwd=current_dir,
            )

            # Get the filtered file list
            file_list = find_process.stdout.strip().split("\n")

            # Create a temporary file to pass to fzf
            with subprocess.Popen(
                [
                    "fzf",
                    "-f",
                    pattern,
                    "-i",
                    "--print-query",
                    "--no-sort",
                    "--tac",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ) as process:
                # Pass the filtered file list to fzf
                stdout, stderr = process.communicate(input="\n".join(file_list))

            if stderr:
                await self.error_repo.insert_error(
                    Error(
                        tool_name="FileSearchService",
                        error_message=f"Error searching files: {stderr}",
                        timestamp=datetime.now().isoformat(),
                    )
                )
                return [{"file_path": pattern, "score": 0, "error": stderr}]

            results = []
            lines = stdout.strip().split("\n")

            query = lines[0] if lines else pattern
            matches = lines[1:] if len(lines) > 1 else []

            if not matches:
                return [
                    {
                        "file_path": pattern,
                        "score": 0,
                        "error": "No matches found",
                    }
                ]

            for match in matches:
                if match:
                    score = 1.0
                    if query.lower() in match.lower():
                        score = 0.8
                    if match.lower().startswith(query.lower()):
                        score = 0.9

                    results.append({"file_path": match, "score": score})

            return results

        except FileNotFoundError:
            await self.error_repo.insert_error(
                Error(
                    tool_name="FileSearchService",
                    error_message="fzf is not installed. Please install it first.",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="fzf is not installed. Please install it first.",
            )

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="FileSearchService",
                    error_message=f"Error searching files: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error searching files: {str(e)}",
            )
