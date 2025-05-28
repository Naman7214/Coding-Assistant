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


async def run_terminal_command(
    command: str,
    is_background: bool,
    workspace_path: str,
    explanation: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Run a terminal command on the user's system.

    Args:
        command: The terminal command to execute
        is_background: Whether the command should be run in the background
        workspace_path: The path to the workspace
        explanation: Explanation for why the command is needed

    Returns:
        A dictionary with the command output and execution status
    """
    url = "http://127.0.0.1:8000/api/v1/run-terminal-cmd"

    payload = {
        "cmd": command,
        "workspace_path": workspace_path,
        "is_background": is_background,
    }
    if explanation:
        payload["explanation"] = explanation

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
