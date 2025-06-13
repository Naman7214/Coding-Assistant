from typing import Optional

import httpx
from dotenv import load_dotenv

from system.mcp_server.config.settings import settings

load_dotenv()


async def web_search_tool(
    search_term: str,
    target_urls: Optional[list[str]] = [],
    explanation: Optional[str] = None,
) -> str:

    url = settings.WEB_SEARCH_API

    payload = {
        "search_term": search_term,
        "target_urls": target_urls,
        "explanation": explanation,
    }

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
