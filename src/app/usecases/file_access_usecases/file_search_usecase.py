from fastapi import Depends
from typing import List, Dict, Any

from src.app.services.file_access_services.file_search_service import FileSearchService


class FileSearchUseCase:
    def __init__(self, file_search_service: FileSearchService = Depends()):
        self.file_search_service = file_search_service
    
    async def execute(self, pattern: str, explanation: str) -> List[Dict[str, Any]]:
  
        return await self.file_search_service.search_files(pattern, explanation) 