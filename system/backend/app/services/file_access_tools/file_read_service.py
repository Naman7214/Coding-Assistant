from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, status

from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.services.terminal_client_service import (
    TerminalClientService,
)
from system.backend.app.utils.path_validator import is_safe_path


class FileReadService:
    def __init__(
        self,
        error_repo: ErrorRepo = Depends(),
        terminal_client: TerminalClientService = Depends(),
    ):
        self.error_repo = error_repo
        self.terminal_client = terminal_client

    def _add_line_numbers(self, content: str, start_line: int = 1) -> str:
        """Add line numbers to content."""
        if not content:
            return content

        lines = content.split("\n")
        numbered_lines = []

        for i, line in enumerate(lines):
            line_number = start_line + i
            numbered_lines.append(f"{line_number:4d}: {line}")

        return "\n".join(numbered_lines)

    def _calculate_context_info(
        self,
        total_lines: int,
        start_line: Optional[int],
        end_line: Optional[int],
    ) -> Dict[str, Any]:
        """Calculate context information about lines above and below the current window."""
        context_info = {
            "lines_above": 0,
            "lines_below": 0,
            "context_summary": "",
        }

        if total_lines == 0:
            return context_info

        # If no range specified, showing entire file
        if start_line is None and end_line is None:
            context_info["context_summary"] = (
                f"Showing entire file ({total_lines} lines)"
            )
            return context_info

        # Calculate actual start and end lines
        actual_start = start_line if start_line is not None else 1
        actual_end = end_line if end_line is not None else total_lines

        # Ensure boundaries are within file limits
        actual_start = max(1, actual_start)
        actual_end = min(total_lines, actual_end)

        # Calculate lines above and below
        lines_above = actual_start - 1
        lines_below = total_lines - actual_end

        context_info["lines_above"] = lines_above
        context_info["lines_below"] = lines_below

        # Create context summary
        summary_parts = []
        if lines_above > 0:
            summary_parts.append(f"{lines_above} lines above")
        if lines_below > 0:
            summary_parts.append(f"{lines_below} lines below")

        if summary_parts:
            context_info["context_summary"] = (
                f"Context: {' and '.join(summary_parts)} the current window"
            )
        else:
            context_info["context_summary"] = "Showing complete file content"

        return context_info

    async def read_file(
        self,
        file_path: str,
        explanation: str,
        workspace_path: Optional[str] = None,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None,
        include_line_numbers: bool = True,
        include_context_info: bool = True,
    ) -> Dict[str, Any]:
        """
        Read the contents of a file using client-side API (no terminal visibility).

        Args:
            file_path: Path to the file to read
            explanation: Explanation for the operation
            workspace_path: The workspace path
            start_line: Starting line number (1-based, optional)
            end_line: Ending line number (1-based, optional)
            include_line_numbers: Whether to add line numbers to content
            include_context_info: Whether to include context information about surrounding lines

        Returns:
            Dictionary with file contents and metadata including context information
        """
        try:
            workspace_path = workspace_path or "/"

            # Check if path is safe
            is_safe, error_msg = is_safe_path(file_path)
            if not is_safe:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unsafe path: {error_msg}",
                )

            # Try client-side file read API first (silent, no terminal window)
            try:
                result = await self.terminal_client.read_file(
                    file_path=file_path,
                    workspace_path=workspace_path,
                    start_line=start_line,
                    end_line=end_line,
                )

                # Get current directory silently
                current_dir_result = (
                    await self.terminal_client.execute_terminal_command(
                        command="pwd",
                        workspace_path=workspace_path,
                        silent=True,
                    )
                )
                current_directory = current_dir_result.get("output", "").strip()

                # Process successful read result
                if "content" in result:
                    content = result["content"]
                    total_lines = result.get("totalLines", 0)

                    # Add line numbers if requested
                    if include_line_numbers:
                        actual_start = (
                            start_line if start_line is not None else 1
                        )
                        content = self._add_line_numbers(content, actual_start)

                    # Calculate context information
                    context_info = {}
                    if include_context_info:
                        context_info = self._calculate_context_info(
                            total_lines, start_line, end_line
                        )

                    response = {
                        "success": True,
                        "content": content,
                        "file_path": file_path,
                        "start_line": start_line,
                        "end_line": end_line,
                        "total_lines": total_lines,
                        "file_size": result.get("fileSize", 0),
                        "currentDirectory": current_directory,
                    }

                    # Add context information if requested
                    if include_context_info:
                        response.update(context_info)

                    return response
                else:
                    raise Exception("No content in response")

            except Exception as client_error:
                # Fallback to terminal command if client API fails
                print(
                    f"Client API failed, using terminal fallback: {client_error}"
                )

                # Check if file exists using silent terminal command
                check_result = (
                    await self.terminal_client.execute_terminal_command(
                        command=f'test -f "{file_path}"',
                        workspace_path=workspace_path,
                        silent=True,
                    )
                )

                if check_result.get("exitCode", 1) != 0:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"File not found: {file_path}",
                    )

                # Read file content using silent cat command
                if start_line is not None and end_line is not None:
                    # Read specific line range using sed
                    read_cmd = (
                        f'sed -n "{start_line},{end_line}p" "{file_path}"'
                    )
                elif start_line is not None:
                    # Read from start_line to end
                    read_cmd = f'tail -n +{start_line} "{file_path}"'
                elif end_line is not None:
                    # Read from beginning to end_line
                    read_cmd = f'head -n {end_line} "{file_path}"'
                else:
                    # Read entire file
                    read_cmd = f'cat "{file_path}"'

                read_result = (
                    await self.terminal_client.execute_terminal_command(
                        command=read_cmd,
                        workspace_path=workspace_path,
                        silent=True,
                    )
                )

                if read_result.get("exitCode", 1) != 0:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"Failed to read file: {read_result.get('error', 'Unknown error')}",
                    )

                content = read_result.get("output", "")

                # Get file stats using silent commands
                file_info = await self._get_file_stats(
                    file_path, workspace_path
                )
                total_lines = file_info.get("total_lines", 0)

                # Add line numbers if requested
                if include_line_numbers:
                    actual_start = start_line if start_line is not None else 1
                    content = self._add_line_numbers(content, actual_start)

                # Calculate context information
                context_info = {}
                if include_context_info:
                    context_info = self._calculate_context_info(
                        total_lines, start_line, end_line
                    )

                # Get current directory silently
                current_dir_result = (
                    await self.terminal_client.execute_terminal_command(
                        command="pwd",
                        workspace_path=workspace_path,
                        silent=True,
                    )
                )
                current_directory = current_dir_result.get("output", "").strip()

                response = {
                    "success": True,
                    "content": content,
                    "file_path": file_path,
                    "start_line": start_line,
                    "end_line": end_line,
                    "total_lines": total_lines,
                    "file_size": file_info.get("file_size", 0),
                    "current_directory": current_directory,
                }

                # Add context information if requested
                if include_context_info:
                    response.update(context_info)

                return response

        except HTTPException:
            raise
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="file_read",
                    error_message=f"Error reading file {file_path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )

            # Get current directory even on error
            try:
                current_dir_result = (
                    await self.terminal_client.execute_terminal_command(
                        command="pwd",
                        workspace_path=workspace_path or "/",
                        silent=True,
                    )
                )
                current_directory = current_dir_result.get("output", "").strip()
            except:
                current_directory = workspace_path or "/"

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Internal error: {str(e)}",
            )

    async def _get_file_stats(
        self, file_path: str, workspace_path: str
    ) -> Dict[str, Any]:
        """Get file statistics using silent terminal commands."""
        try:
            # Get line count
            line_count_result = (
                await self.terminal_client.execute_terminal_command(
                    command=f'wc -l "{file_path}" 2>/dev/null | cut -d" " -f1',
                    workspace_path=workspace_path,
                    silent=True,
                )
            )

            total_lines = 0
            if line_count_result.get("exitCode", 1) == 0:
                try:
                    total_lines = int(
                        line_count_result.get("output", "0").strip()
                    )
                except ValueError:
                    total_lines = 0

            # Get file size (cross-platform)
            size_result = await self.terminal_client.execute_terminal_command(
                command=f'stat -c "%s" "{file_path}" 2>/dev/null || stat -f "%z" "{file_path}" 2>/dev/null',
                workspace_path=workspace_path,
                silent=True,
            )

            file_size = 0
            if size_result.get("exitCode", 1) == 0:
                try:
                    file_size = int(size_result.get("output", "0").strip())
                except ValueError:
                    file_size = 0

            return {"total_lines": total_lines, "file_size": file_size}

        except Exception:
            return {"total_lines": 0, "file_size": 0}
