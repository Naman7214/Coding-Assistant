from typing import Any, Dict, Optional

from fastapi import Depends

from backend.app.services.modification_tools.search_replace_service import (
    SearchReplaceService,
)


class SearchReplaceUseCase:
    def __init__(
        self, search_replace_service: SearchReplaceService = Depends()
    ):
        self.search_replace_service = search_replace_service

    async def execute(
        self,
        query: str,
        replacement: str,
        explanation: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:

        return await self.search_replace_service.search_and_replace(
            query, replacement, explanation, options
        )
