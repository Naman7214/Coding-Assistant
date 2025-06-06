from typing import Any, Dict

from fastapi import Depends

from system.backend.app.services.file_access_tools.directory_list_service import (
    DirectoryListService,
)


class DirectoryListUseCase:
    def __init__(
        self, directory_list_service: DirectoryListService = Depends()
    ):
        self.directory_list_service = directory_list_service

    async def execute(
        self,
        dir_path: str,
        recursive: bool,
        explanation: str,
        workspace_path: str = None,
    ) -> Dict[str, Any]:

        return await self.directory_list_service.list_directory(
            directory_path=dir_path,
            explanation=explanation,
            workspace_path=workspace_path,
            include_hidden=False,
            recursive=recursive,
        )
