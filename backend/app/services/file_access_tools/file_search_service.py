import os
import subprocess
from typing import List, Dict, Any
from datetime import datetime
from fastapi import Depends, HTTPException, status

from backend.app.models.domain.error import Error
from backend.app.repositories.error_repo import ErrorRepo

class FileSearchService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo
    
    async def search_files(self, pattern: str, explanation: str) -> List[Dict[str, Any]]:
        try:
            current_dir = os.getcwd()
            
            cmd = [
                'fzf',
                '-f', pattern,
                '-i',
                '--print-query',
                '--no-sort',
                '--tac'
            ]

            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=current_dir
            )

            stdout, stderr = process.communicate()

            if stderr:
                await self.error_repo.insert_error(Error(
                    tool_name="FileSearchService",
                    error_message=f"Error searching files: {stderr}",
                    timestamp=datetime.now().isoformat()
                ))
                return [{
                    'file_path': pattern,
                    'score': 0,
                    'error': stderr
                }]

            results = []
            lines = stdout.strip().split('\n')
            
            query = lines[0] if lines else pattern
            matches = lines[1:] if len(lines) > 1 else []
            
            if not matches:
                return [{
                    'file_path': pattern,
                    'score': 0,
                    'error': 'No matches found'
                }]
            
            for match in matches:
                if match:
                    score = 1.0
                    if query.lower() in match.lower():
                        score = 0.8
                    if match.lower().startswith(query.lower()):
                        score = 0.9

                    results.append({
                        'file_path': match,
                        'score': score
                    })

            return results

        except FileNotFoundError:
            await self.error_repo.insert_error(Error(
                tool_name="FileSearchService",
                error_message="fzf is not installed. Please install it first.",
                timestamp=datetime.now().isoformat()
            ))
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="fzf is not installed. Please install it first.")
        
        except Exception as e:
            await self.error_repo.insert_error(Error(
                tool_name="FileSearchService",
                error_message=f"Error searching files: {str(e)}",
                timestamp=datetime.now().isoformat()
            ))
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error searching files: {str(e)}")