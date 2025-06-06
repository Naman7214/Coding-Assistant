import os
from datetime import datetime
from typing import Any, Dict, Optional

import httpx
from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo


class TerminalClientService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo
        self.client_api_url = os.getenv(
            "CLIENT_API_URL", "http://localhost:3001"
        )
        self.timeout = httpx.Timeout(
            connect=60.0,
            read=150.0,
            write=150.0,
            pool=60.0,
        )

    async def _make_request(
        self, operation_type: str, workspace_path: str, **kwargs
    ) -> Dict[str, Any]:
        """
        Make a request to the client-side terminal API.

        Args:
            operation_type: The type of operation to perform
            workspace_path: The workspace path
            **kwargs: Additional parameters for the request

        Returns:
            The response from the client API
        """
        url = f"{self.client_api_url}/api/terminal/execute"

        payload = {
            "operationType": operation_type,
            "workspacePath": workspace_path,
            **kwargs,
        }

        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()

                response_data = response.json()

                if not response_data.get("success", False):
                    error_msg = response_data.get(
                        "error", "Unknown error from client API"
                    )
                    await self.error_repo.insert_error(
                        Error(
                            tool_name="TerminalClientService",
                            error_message=f"Client API error: {error_msg}",
                            timestamp=datetime.now().isoformat(),
                        )
                    )
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"Client API error: {error_msg}",
                    )

                return response_data.get("data", {})

        except httpx.HTTPStatusError as e:
            error_msg = f"HTTP {e.response.status_code}: {e.response.text}"
            await self.error_repo.insert_error(
                Error(
                    tool_name="TerminalClientService",
                    error_message=error_msg,
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Client API unavailable: {error_msg}",
            )
        except httpx.RequestError as e:
            error_msg = f"Request error: {str(e)}"
            await self.error_repo.insert_error(
                Error(
                    tool_name="TerminalClientService",
                    error_message=error_msg,
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Client API unavailable: {error_msg}",
            )

    async def execute_terminal_command(
        self,
        command: str,
        workspace_path: str,
        working_directory: Optional[str] = None,
        environment_variables: Optional[Dict[str, str]] = None,
        is_background: bool = False,
        timeout: Optional[int] = None,
        silent: bool = False,
    ) -> Dict[str, Any]:
        """Execute a terminal command on the client side."""
        return await self._make_request(
            operation_type="terminal_command",
            workspace_path=workspace_path,
            command=command,
            workingDirectory=working_directory,
            environmentVariables=environment_variables,
            isBackground=is_background,
            timeout=timeout,
            silent=silent,
        )

    async def read_file(
        self,
        file_path: str,
        workspace_path: str,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Read a file from the client side."""
        return await self._make_request(
            operation_type="read_file",
            workspace_path=workspace_path,
            filePath=file_path,
            startLine=start_line,
            endLine=end_line,
        )

    async def write_file(
        self,
        file_path: str,
        content: str,
        workspace_path: str,
    ) -> Dict[str, Any]:
        """Write content to a file on the client side."""
        return await self._make_request(
            operation_type="write_file",
            workspace_path=workspace_path,
            filePath=file_path,
            content=content,
        )

    async def delete_file(
        self,
        file_path: str,
        workspace_path: str,
    ) -> Dict[str, Any]:
        """Delete a file on the client side."""
        return await self._make_request(
            operation_type="delete_file",
            workspace_path=workspace_path,
            filePath=file_path,
        )

    async def list_directory(
        self,
        directory_path: str,
        workspace_path: str,
    ) -> Dict[str, Any]:
        """List contents of a directory on the client side."""
        return await self._make_request(
            operation_type="list_directory",
            workspace_path=workspace_path,
            directoryPath=directory_path,
        )

    async def search_files(
        self,
        search_pattern: str,
        workspace_path: str,
        directory_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Search for files on the client side."""
        return await self._make_request(
            operation_type="search_files",
            workspace_path=workspace_path,
            searchPattern=search_pattern,
            directoryPath=directory_path,
        )
