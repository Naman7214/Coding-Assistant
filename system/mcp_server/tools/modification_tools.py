# import aiofiles
import json
import logging
from typing import Any, Dict, Optional

import httpx
from dotenv import load_dotenv

from system.mcp_server.config.settings import settings

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def search_and_replace_tool(
    query: str,
    replacement: str,
    explanation: str,
    workspace_path: str,
    options: Optional[Dict[str, Any]] = None,
):
    """
    Search for text and replace it in files.

    Args:
        query: The text or regex pattern to search for
        replacement: The text to replace the matched content with
        workspace_path: The path to the workspace
        explanation: Explanation for why the search and replace is needed
        options: Dictionary containing search options

    Returns:
        Dictionary with results of the operation
    """

    url = settings.SEARCH_AND_REPLACE_API

    payload = {
        "query": query,
        "replacement": replacement,
        "explanation": explanation,
        "workspace_path": workspace_path,
    }
    if options:
        payload["options"] = options

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


async def edit_file_tool(target_file_path: str, code_snippet: str):
    url = settings.EDIT_FILE_API
    payload = {"filePath": target_file_path, "codeSnippet": code_snippet}
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
        return f"HTTP status error occurred: {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f" HTTP Request error occurred: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


async def reapply_tool(target_file_path: str, code_snippet: str):
    url = settings.REAPPLY_API
    payload = {"filePath": target_file_path, "codeSnippet": code_snippet}
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
        return f"HTTP status error occurred: {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f" HTTP Request error occurred: {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"
