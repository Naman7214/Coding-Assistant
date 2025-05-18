import os
from typing import Dict, Any
from datetime import datetime
from fastapi import Depends, HTTPException, status

from src.app.models.domain.error import Error
from src.app.repositories.error_repo import ErrorRepo
from pathlib import Path
import shutil

class FileDeletionService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo
        self.PROTECTED_PATHS = {
            'node_modules',
            'package.json',
            'package-lock.json',
            'yarn.lock',
            'tsconfig.json',
            'next.config.js',
            '.git',
            '.env',
            '.env.local',
            '.env.development',
            '.env.production',
            'public',
            # 'src', src nikala vrna andr ka kuch delete bnai krne dega 
            'build',
            'dist',
            '.next',
            'README.md',
            'venv',
            '.venv'
        }
    
    async def delete_file(self, path: str, explanation: str) -> Dict[str, Any]:
        """
        Delete a file or directory with safety checks.
        
        Args:
            path: Path to the file or directory to delete
            explanation: Explanation for why the deletion is needed
            
        Returns:
            A dictionary with the deletion status and any error
        """

        try:    
            abs_path = os.path.abspath(path)
            
            if not os.path.exists(abs_path):
                return {
                    'deleted': path,
                    'error': 'File does not exist'
                }

            path_parts = Path(abs_path).parts
            
            for part in path_parts:
                if part in self.PROTECTED_PATHS:
                    await self.error_repo.insert_error(Error(
                        tool_name="FileDeletionService",
                        error_message=f"Cannot delete protected path: {part}",
                        timestamp=datetime.now().isoformat()
                    ))
                    return {
                        'deleted': path,
                        'error': f'Cannot delete protected path: {part}'
                    }

            if abs_path.startswith('/System') or abs_path.startswith('/Library'):
                await self.error_repo.insert_error(Error(
                    tool_name="FileDeletionService",
                    error_message=f"Cannot delete system files: {abs_path}",
                    timestamp=datetime.now().isoformat()
                ))
                return {
                    'deleted': path,
                    'error': 'Cannot delete system files'
                }
            
            if any(part.startswith('.') for part in path_parts):
                await self.error_repo.insert_error(Error(
                    tool_name="FileDeletionService",
                    error_message=f"Cannot delete hidden files: {abs_path}",
                    timestamp=datetime.now().isoformat()
                ))
                return {
                    'deleted': path,
                    'error': 'Cannot delete hidden files'
                }

            if os.path.isdir(abs_path):
                shutil.rmtree(abs_path)
            else:
                os.remove(abs_path)

            return {
                'deleted': path,
                'error': None
            }

        except PermissionError:
            await self.error_repo.insert_error(Error(
                tool_name="FileDeletionService",
                error_message=f"Permission denied: {abs_path}",
                timestamp=datetime.now().isoformat()
            ))
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Permission denied: {abs_path}")
        
        except Exception as e:
            await self.error_repo.insert_error(Error(
                tool_name="FileDeletionService",
                error_message=f"Error deleting file: {abs_path}",
                timestamp=datetime.now().isoformat()
            ))
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error deleting file: {abs_path}")