import json
import logging
from typing import Optional

import httpx
from dotenv import load_dotenv

from system.mcp_server.config.settings import settings

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def codebase_search_tool(
    query: str, explanation: str, hashed_workspace_path: str, git_branch: str
):
    """
    Search the codebase for the given query.
    """
    metadata_url = settings.CODEBASE_SEARCH_METADATA_API
    codebase_search_url = settings.CODEBASE_SEARCH_API

    payload = {
        "query": query,
        "explanation": explanation,
        "hashed_workspace_path": hashed_workspace_path,
        "git_branch": git_branch,
    }

    try:
        async with httpx.AsyncClient(
            verify=False, timeout=settings.httpx_timeout
        ) as client:
            metadata_response = await client.post(metadata_url, json=payload)
            metadata_response.raise_for_status()
            metadata_response_json = metadata_response.json()
            code_content_response = await client.post(
                codebase_search_url, json=metadata_response_json
            )
            code_content_response.raise_for_status()
            code_content_response_json = code_content_response.json()
            print(json.dumps(code_content_response_json, indent=4))
            return code_content_response_json
    except httpx.HTTPStatusError as e:
        return f"HTTP status error occurred: {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f" HTTP Request error occurred: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


async def execute_grep_search_tool(
    query: str,
    case_sensitive: bool = False,
    include_pattern: Optional[str] = None,
    exclude_pattern: Optional[str] = None,
    explanation: Optional[str] = None,
    workspace_path: Optional[str] = None,
):
    """
    Execute a grep search using ripgrep.

    Args:
        query: The regex pattern to search for
        case_sensitive: Whether the search should be case sensitive
        include_pattern: Glob pattern for files to include
        exclude_pattern: Glob pattern for files to exclude
        explanation: Explanation for why the search is being performed

    Returns:
        A dictionary with the search results and metadata
    """

    url = settings.EXECUTE_GREP_SEARCH_API

    payload = {
        "query": query,
    }
    if case_sensitive:
        payload["case_sensitive"] = case_sensitive
    if include_pattern:
        payload["include_pattern"] = include_pattern
    if exclude_pattern:
        payload["exclude_pattern"] = exclude_pattern
    if explanation:
        payload["explanation"] = explanation
    if workspace_path:
        payload["workspace_path"] = workspace_path

    try:
        async with httpx.AsyncClient(
            verify=False, timeout=settings.httpx_timeout
        ) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            response_json = response.json()
            # print(response_json)
            print(json.dumps(response_json, indent=4))

            # result = response_json.get("content", "")
            return response_json
    except httpx.HTTPStatusError as e:
        return f"HTTP Status error occurred : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occurred : {str(e)}"
    except Exception as e:
        return f"An error occurred : {str(e)}"
