from typing import Any, Dict, List

from fastapi import Depends

from backend.app.services.file_access_tools.directory_list_service import (
    DirectoryListService,
)


class DirectoryListUseCase:
    def __init__(
        self, directory_list_service: DirectoryListService = Depends()
    ):
        self.directory_list_service = directory_list_service

    async def execute(
        self, dir_path: str, recursive: bool, explanation: str
    ) -> List[Dict[str, Any]]:

        return await self.directory_list_service.list_directory(
            dir_path, recursive, explanation
        )
