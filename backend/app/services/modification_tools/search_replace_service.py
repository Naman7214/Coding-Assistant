import asyncio
import glob
import os
import re
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, status

from backend.app.models.domain.error import Error
from backend.app.repositories.error_repo import ErrorRepo


class SearchReplaceService:
    def __init__(self, error_repo: ErrorRepo = Depends()):
        self.error_repo = error_repo

    async def search_and_replace(
        self,
        query: str,
        replacement: str,
        explanation: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Search for text and replace it in files.

        Args:
            query: The text or regex pattern to search for
            replacement: The text to replace the matched content with
            options: Dictionary containing search options
            explanation: Explanation for the operation

        Returns:
            Dictionary with results of the operation
        """

        if options is None:
            options = {}

        case_sensitive = options.get("case_sensitive", True)
        include_pattern = options.get("include_pattern", "*")
        exclude_pattern = options.get("exclude_pattern", "")
        search_paths = options.get("search_paths", ["."])

        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            pattern = re.compile(query, flags)
        except re.error as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Invalid regex pattern: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            return {
                "success": False,
                "error": f"Invalid regex pattern: {str(e)}",
                "files_affected": 0,
                "matches": 0,
            }

        results = {
            "success": True,
            "files_affected": 0,
            "matches": 0,
            "changes": [],
        }

        try:
            # Process paths concurrently
            tasks = []
            for path in search_paths:
                task = self._process_path(
                    path,
                    pattern,
                    replacement,
                    include_pattern,
                    exclude_pattern,
                    results,
                )
                tasks.append(task)

            await asyncio.gather(*tasks)

            return results

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Error in search and replace: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error in search and replace: {str(e)}",
            )

    async def _process_path(
        self,
        path: str,
        pattern: re.Pattern,
        replacement: str,
        include_pattern: str,
        exclude_pattern: str,
        results: Dict[str, Any],
    ) -> None:
        """Process a single search path asynchronously."""

        if os.path.isdir(path):
            include_paths = []
            for root, _, files in os.walk(path):
                for inc_pattern in include_pattern.split(","):
                    inc_pattern = inc_pattern.strip()
                    glob_pattern = os.path.join(root, inc_pattern)
                    include_paths.extend(glob.glob(glob_pattern))

            if exclude_pattern:
                for root, _, files in os.walk(path):
                    for exc_pattern in exclude_pattern.split(","):
                        exc_pattern = exc_pattern.strip()
                        glob_pattern = os.path.join(root, exc_pattern)
                        exclude_paths = set(glob.glob(glob_pattern))
                        include_paths = [
                            p for p in include_paths if p not in exclude_paths
                        ]
        else:
            include_paths = (
                [path] if self._matches_pattern(path, include_pattern) else []
            )
            if exclude_pattern and self._matches_pattern(path, exclude_pattern):
                include_paths = []

        file_tasks = []
        for file_path in include_paths:
            if os.path.isfile(file_path):
                task = self._process_file(
                    file_path, pattern, replacement, results
                )
                file_tasks.append(task)

        await asyncio.gather(*file_tasks)

    def _matches_pattern(self, path: str, pattern: str) -> bool:
        """Check if a path matches a glob pattern."""
        for single_pattern in pattern.split(","):
            single_pattern = single_pattern.strip()
            if glob.fnmatch.fnmatch(os.path.basename(path), single_pattern):
                return True
        return False

    async def _process_file(
        self,
        file_path: str,
        pattern: re.Pattern,
        replacement: str,
        results: Dict[str, Any],
    ) -> None:
        """Process a single file for search and replace asynchronously."""
        try:
            # Read file content using standard open
            with open(
                file_path, "r", encoding="utf-8", errors="ignore"
            ) as file:
                original_content = file.read()

            matches = list(pattern.finditer(original_content))
            if not matches:
                return

            new_content = pattern.sub(replacement, original_content)
            file_changes = []

            for match in matches:
                start, end = match.span()
                before_ctx = original_content[max(0, start - 20) : start]
                matched_text = original_content[start:end]
                after_ctx = original_content[
                    end : min(len(original_content), end + 20)
                ]

                replaced_text = pattern.sub(replacement, matched_text)

                file_changes.append(
                    {
                        "line_number": original_content[:start].count("\n") + 1,
                        "context": f"{before_ctx}[{matched_text}]{after_ctx}",
                        "replacement": replaced_text,
                    }
                )

            # Apply changes if not preview mode
            with open(file_path, "w", encoding="utf-8") as file:
                file.write(new_content)

            # Update results with a lock to avoid race conditions
            async with asyncio.Lock():
                results["files_affected"] += 1
                results["matches"] += len(matches)
                results["changes"].append(
                    {
                        "file": file_path,
                        "matches": len(matches),
                        "changes": file_changes,
                    }
                )

        except Exception as e:
            async with asyncio.Lock():
                results["success"] = False
                results["error"] = (
                    f"Error processing file {file_path}: {str(e)}"
                )

            await self.error_repo.insert_error(
                Error(
                    tool_name="SearchReplaceService",
                    error_message=f"Error processing file {file_path}: {str(e)}",
                    timestamp=datetime.now().isoformat(),
                )
            )
