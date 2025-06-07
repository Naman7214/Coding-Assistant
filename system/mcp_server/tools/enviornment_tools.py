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


async def run_terminal_command_tool(
    command: str,
    workspace_path: str,
    is_background: bool = False,
    explanation: Optional[str] = None,
):
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
    url = settings.RUN_CMD_API

    payload = {
        "cmd": command,
        "workspace_path": workspace_path,
        "is_background": False,
    }
    if explanation:
        payload["explanation"] = explanation

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
