import json
import logging
from typing import Any, Dict, List, Optional

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


async def read_file(
    file_path: str,
    explanation: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
) -> Dict[str, Any]:

    url = "http://192.168.17.182:8000/api/v1/read-file"

    payload = {"file_path": file_path, "explanation": explanation}

    if start_line:
        payload["start_line"] = start_line
    if end_line:
        payload["end_line"] = end_line

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
        return f"HTTP Status error occured : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occured : {str(e)}"
    except Exception as e:
        return f"An error occured : {str(e)}"


async def delete_file(path: str, explanation: str) -> Dict[str, Any]:
    """
    Delete a file or directory with safety checks.

    Args:
        path: Path to the file or directory to delete
        explanation: Explanation for why the deletion is needed

    Returns:
        A dictionary with the deletion status and any error
    """

    url = "http://192.168.17.182:8000/api/v1/delete-file"

    payload = {"path": path, "explanation": explanation}

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
        return f"HTTP Status error occured : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occured : {str(e)}"
    except Exception as e:
        return f"An error occured : {str(e)}"


# backend me change krna he list directory me recursive parameter nikal na he
async def list_directory(
    dir_path: Optional[str] = None,
    # recursive: bool = True,
    explanation: str = "",
) -> List[Dict[str, Any]]:

    url = "http://192.168.17.182:8000/api/v1/list-directory"

    payload = {
        "dir_path": dir_path if dir_path else " ",
        "explanation": explanation,
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
        return f"HTTP Status error occured : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occured : {str(e)}"
    except Exception as e:
        return f"An error occured : {str(e)}"


async def search_files(query: str, explanation: str) -> List[Dict[str, Any]]:

    url = "http://192.168.17.182:8000/api/v1/search-files"

    payload = {"pattern": query, "explanation": explanation}

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
        return f"HTTP Status error occured : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occured : {str(e)}"
    except Exception as e:
        return f"An error occured : {str(e)}"
