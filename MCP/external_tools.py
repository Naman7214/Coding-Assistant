import json
import logging

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


async def web_search(
    search_term: str, target_urls: list[str] = [], explanation: str = ""
) -> str:

    url = "http://192.168.17.182:8000/api/v1/web-search"

    payload = {
        "search_term": search_term,
        "target_urls": target_urls,
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
