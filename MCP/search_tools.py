import json
import logging
from typing import Any, Dict, Optional

import httpx
from dotenv import load_dotenv

# import aiofiles


load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

timeout = httpx.Timeout(
    connect=60.0,  # Time to establish a connection
    read=150.0,  # Time to read the response
    write=150.0,  # Time to send data
    pool=60.0,  # Time to wait for a connection from the pool
)


async def codebase_search(
    query: str, explanation: str, target_directories: Optional[list[str]] = []
):
    """
    Search the codebase for the given query.
    """
    url = "http://192.168.17.182:8000/api/v1/code_base_search"

    payload = {
        "query": query,
        "explanation": explanation,
        "target_directories": target_directories if target_directories else [],
    }

    try:
        async with httpx.AsyncClient(verify=False, timeout=timeout) as client:
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


async def execute_grep_search(
    query: str,
    case_sensitive: bool = False,
    include_pattern: Optional[str] = None,
    exclude_pattern: Optional[str] = None,
    explanation: Optional[str] = None,
) -> Dict[str, Any]:
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

    url = "http://192.168.17.182:8000/api/v1/grep_search"

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

    try:
        async with httpx.AsyncClient(verify=False, timeout=60) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            response_json = response.json()
            # print(response_json)
            print(json.dumps(response_json, indent=4))

            # result = response_json.get("content", "")
            return response_json
    except httpx.HTTPStatusError as e:
        return f"HTTP Status error occured : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occured : {str(e)}"
    except Exception as e:
        return f"An error occured : {str(e)}"
