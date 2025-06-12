import json
import time
from typing import AsyncGenerator

from fastapi import Depends, status
from fastapi.responses import JSONResponse

from system.backend.app.models.schemas.modification_schemas import (
    EditFileRequest,
)
from system.backend.app.usecases.modification_tools.edit_file_usecase import (
    EditFileUsecase,
)


class EditFileController:
    def __init__(
        self, edit_file_usecase: EditFileUsecase = Depends(EditFileUsecase)
    ):
        self.edit_file_usecase = edit_file_usecase

    async def execute(self, request: EditFileRequest):
        response = await self.edit_file_usecase.execute(
            request.target_file_content, request.code_snippet
        )

        status_code = status.HTTP_200_OK
        if not response.get("success", True):
            status_code = status.HTTP_400_BAD_REQUEST

        message = "Search and replace completed successfully"
        if response.get("error"):
            message = response["error"]

        return JSONResponse(
            content={
                "data": response,
                "message": message,
                "error": response.get("error"),
            },
            status_code=status_code,
        )

    async def execute_stream(
        self, request: EditFileRequest
    ) -> AsyncGenerator[str, None]:
        """Stream the file editing process as server-sent events"""
        try:
            # Send initial start event
            yield self._create_sse_event(
                "start",
                "Starting file edit process...",
                {
                    "code_snippet_length": len(request.code_snippet),
                    "target_content_length": len(request.target_file_content),
                },
            )

            # Stream the actual editing process
            async for event in self.edit_file_usecase.execute_stream(
                request.target_file_content, request.code_snippet
            ):
                yield event

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Controller error: {str(e)}",
                {"timestamp": time.time()},
            )

    def _create_sse_event(
        self, event_type: str, content: str, metadata: dict = None
    ) -> str:
        """Create a server-sent event formatted string"""
        event_data = {
            "type": event_type,
            "content": content,
            "metadata": metadata or {},
            "timestamp": time.time(),
        }
        return f"data: {json.dumps(event_data)}\n\n"
