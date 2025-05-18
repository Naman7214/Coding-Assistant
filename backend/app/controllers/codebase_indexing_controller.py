from fastapi import Depends, status
from fastapi.responses import JSONResponse

from backend.app.usecases.codebase_indexing_usecase import CodebaseIndexingUseCase


class CodebaseIndexingController:
    def __init__(
        self,
        codebase_indexing_usecase: CodebaseIndexingUseCase = Depends(
            CodebaseIndexingUseCase
        ),
    ):
        self.codebase_indexing_usecase = codebase_indexing_usecase

    async def sync_codebase_index(self):
        result = await self.codebase_indexing_usecase.sync_codebase_index()
        return JSONResponse(
            content={
                "data": result,
                "message": "Codebase indexing completed successfully",
                "error": None,
            },
            status_code=status.HTTP_200_OK,
        )
