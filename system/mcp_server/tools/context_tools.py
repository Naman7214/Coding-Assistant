import logging
from typing import Any, Dict

import httpx

logger = logging.getLogger(__name__)


async def get_project_structure_tool(max_depth: int = 8) -> Dict[str, Any]:
    """
    Fetches the project structure from the VS Code extension's context API.

    Args:
        explanation: Explanation for using this tool
        max_depth: Maximum depth to traverse (default: 8)

    Returns:
        Dict containing the project structure or error information
    """
    try:
        # Construct the API endpoint URL
        base_url = "http://localhost:3001/api/context/project-structure"

        # Prepare query parameters
        params = {
            "maxDepth": max_depth,
        }

        logger.info(
            f"Fetching project structure from {base_url} with params: {params}"
        )

        # Make the HTTP request to the extension's API
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(base_url, params=params)
            response.raise_for_status()

            result = response.json()

            return {
                "success": True,
                "project_structure": result,
                "max_depth": max_depth,
            }

    except httpx.TimeoutException:
        logger.error("Timeout while fetching project structure")
        return {
            "success": False,
            "error": "Request timeout while fetching project structure",
        }

    except httpx.HTTPStatusError as e:
        logger.error(
            f"HTTP error while fetching project structure: {e.response.status_code}"
        )
        return {
            "success": False,
            "error": f"HTTP {e.response.status_code} error while fetching project structure",
        }

    except Exception as e:
        logger.error(
            f"Unexpected error while fetching project structure: {str(e)}"
        )
        return {
            "success": False,
            "error": f"Unexpected error: {str(e)}",
        }


async def get_git_context_tool(include_changes: bool = False) -> Dict[str, Any]:
    """
    Fetches the git context from the VS Code extension's context API.

    Args:
        include_changes: Whether to include diff information (default: False)

    Returns:
        Dict containing the git context or error information
    """
    try:
        # Construct the API endpoint URL
        base_url = "http://localhost:3001/api/context/git"

        # Prepare query parameters
        params = {
            "includeChanges": str(include_changes).lower(),
        }

        logger.info(
            f"Fetching git context from {base_url} with params: {params}"
        )

        # Make the HTTP request to the extension's API
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(base_url, params=params)
            response.raise_for_status()

            result = response.json()

            return {
                "success": True,
                "git_context": result,
                "include_changes": include_changes,
            }

    except httpx.TimeoutException:
        logger.error("Timeout while fetching git context")
        return {
            "success": False,
            "error": "Request timeout while fetching git context",
        }

    except httpx.HTTPStatusError as e:
        logger.error(
            f"HTTP error while fetching git context: {e.response.status_code}"
        )
        return {
            "success": False,
            "error": f"HTTP {e.response.status_code} error while fetching git context",
        }

    except Exception as e:
        logger.error(f"Unexpected error while fetching git context: {str(e)}")
        return {
            "success": False,
            "error": f"Unexpected error: {str(e)}",
        }
