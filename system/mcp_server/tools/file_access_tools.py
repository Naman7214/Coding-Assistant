import json
import logging
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

from system.mcp_server.config.settings import settings

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def read_file_tool(
    file_path: str,
    explanation: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
    workspace_path: Optional[str] = None,
) -> Dict[str, Any]:

    url = settings.READ_FILE_API

    payload = {"file_path": file_path, "explanation": explanation}

    if start_line:
        payload["start_line"] = start_line
    if end_line:
        payload["end_line"] = end_line
    if workspace_path:
        payload["workspace_path"] = workspace_path

    try:
        async with httpx.AsyncClient(
            verify=False, timeout=settings.httpx_timeout
        ) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            response_json = response.json()
            return response_json
    except httpx.HTTPStatusError as e:
        return f"HTTP Status error occurred : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occurred : {str(e)}"
    except Exception as e:
        return f"An error occurred : {str(e)}"


async def delete_file_tool(
    path: str, explanation: str, workspace_path: Optional[str] = None
) -> Dict[str, Any]:
    """
    Delete a file or directory with safety checks.

    Args:
        path: Path to the file or directory to delete
        explanation: Explanation for why the deletion is needed

    Returns:
        A dictionary with the deletion status and any error
    """

    url = settings.DELETE_FILE_API

    payload = {"path": path, "explanation": explanation}

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


async def list_directory_tool(
    dir_path: Optional[str] = None,
    workspace_path: Optional[str] = None,
    explanation: str = "",
) -> List[Dict[str, Any]]:

    payload = {
        "explanation": explanation,
    }

    if dir_path:
        payload["dir_path"] = dir_path
    if workspace_path:
        payload["workspace_path"] = workspace_path

    try:
        async with httpx.AsyncClient(
            verify=False, timeout=settings.httpx_timeout
        ) as client:
            response = await client.post(settings.LIST_DIR_API, json=payload)
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


async def search_files_tool(
    query: str, workspace_path: str, explanation: str
) -> List[Dict[str, Any]]:

    url = settings.SEARCH_FILES_API

    payload = {
        "pattern": query,
        "workspace_path": workspace_path,
        "explanation": explanation,
    }

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
