import json
import time
from typing import Any, AsyncGenerator, Dict

from fastapi import Depends

from system.backend.app.services.modification_tools.edit_file_service import (
    EditFileService,
)


class EditFileUsecase:
    def __init__(self, edit_file_service: EditFileService = Depends()):
        self.edit_file_service = edit_file_service

    async def execute(
        self,
        target_file_content: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ) -> Dict[str, Any]:

        return await self.edit_file_service.edit_file(
            target_file_content, code_snippet, explanation, workspace_path
        )

    async def execute_stream(
        self,
        target_file_content: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ) -> AsyncGenerator[str, None]:
        """Stream the file editing process as server-sent events"""
        try:
            # Send processing start event
            yield self._create_sse_event(
                "processing",
                "Preparing to apply code changes...",
                {
                    "stage": "preparation",
                    "workspace_path": workspace_path,
                },
            )

            # Stream from service layer
            async for event in self.edit_file_service.edit_file_stream(
                target_file_content, code_snippet, explanation, workspace_path
            ):
                yield event

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Use case error: {str(e)}",
                {"stage": "usecase", "timestamp": time.time()},
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
