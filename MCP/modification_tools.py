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




async def search_and_replace(
    query: str,
    replacement: str,
    explanation: str,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Search for text and replace it in files.
    
    Args:
        query: The text or regex pattern to search for
        replacement: The text to replace the matched content with
        options: Dictionary containing search options
        
    Returns:
        Dictionary with results of the operation
    """

    url = "http://192.168.17.182:8000/api/v1/search-replace"
            
    payload = {
        "query": query,
        "replacement": replacement,
        "explanation": explanation
    }
    if options:
        payload["options"] = options
   
    try:
        async with httpx.AsyncClient(verify=False, timeout = timeout) as client:
            response = await client.post(url, json = payload)
            response.raise_for_status()
            response_json =  response.json()
            # print(response_json)
            print(json.dumps(response_json, indent=4))

            # result = response_json.get("content", "")
            return response_json
    except httpx.HTTPStatusError as e:
        return f"HTTP Status error occured : {e.response.status_code} {e.response.text}"
    except httpx.RequestError as e:
        return f"HTTP request error occured : {str(e)}"
    except Exception as e :
        return f"An error occured : {str(e)}"
