import httpx

from system.backend.app.config.settings import settings


class TavilySearchService:
    def __init__(self):
        self.time_out = httpx.Timeout(180)

    async def tavily_search(
        self, query: str, max_results: int = 2, time_range: str = "month"
    ) -> dict:
        """
        Make a POST request to the Tavily API to search for information.

        Args:
            query: The search query
            max_results: Maximum number of results to return
            time_range: Time range for the search results

        Returns:
            The JSON response from the API
        """
        url = "https://api.tavily.com/search"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.TAVILY_API_KEY}",
        }
        data = {
            "query": query,
            "max_results": max_results,
            "time_range": time_range,
        }

        async with httpx.AsyncClient(
            verify=False, timeout=self.time_out
        ) as client:
            try:
                response = await client.post(url, headers=headers, json=data)
                response.raise_for_status()
                return response.json()
            except Exception as e:
                print(str(e))
                return None
