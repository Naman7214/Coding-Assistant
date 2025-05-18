import asyncio
import json

import tiktoken
from fastapi import Depends

from backend.app.config.settings import settings
from backend.app.models.schemas.web_search_query_schema import (
    WebSearchQueryRequest,
)
from backend.app.services.external_tools.scrape_webpages_service import (
    ScrapeWebpagesService,
)
from backend.app.services.external_tools.summerize_webpage_service import (
    SummarizeWebpageService,
)
from backend.app.services.external_tools.tavily_search_service import (
    TavilySearchService,
)


class WebSearchUsecase:
    def __init__(
        self,
        tavily_search_service: TavilySearchService = Depends(
            TavilySearchService
        ),
        scrape_webpages_service: ScrapeWebpagesService = Depends(
            ScrapeWebpagesService
        ),
        summarize_webpage_service: SummarizeWebpageService = Depends(
            SummarizeWebpageService
        ),
    ):
        self.tavily_search_service = tavily_search_service
        self.scrape_webpages_service = scrape_webpages_service
        self.summarize_webpage_service = summarize_webpage_service
        self.encoding = tiktoken.get_encoding("cl100k_base")

    def _count_tokens(self, text: str) -> int:
        """Count the number of tokens in the text using tiktoken."""
        tokens = self.encoding.encode(text)
        return len(tokens)

    async def web_search(self, request: WebSearchQueryRequest) -> str:
        search_term = request.search_term
        target_urls = request.target_urls
        explanation = request.explanation
        # If target_urls are provided, use them directly
        if target_urls:
            urls_to_scrape = target_urls
        else:
            # Original Tavily search logic when no target_urls are provided
            search_results = await self.tavily_search_service.tavily_search(
                search_term
            )
            urls_to_scrape = [
                result["url"] for result in search_results["results"]
            ]

        # Create tasks for scraping each URL concurrently
        scraping_tasks = [
            self.scrape_webpages_service.scrape_web_page(url)
            for url in urls_to_scrape
        ]

        # Gather all scraping results
        scraped_contents = await asyncio.gather(
            *scraping_tasks, return_exceptions=True
        )

        # Process each scraped content
        enriched_results = []
        summarization_tasks = []
        indices_to_summarize = []

        # First pass: process all content and identify what needs summarization
        for i, url in enumerate(urls_to_scrape):
            if isinstance(scraped_contents[i], Exception):
                enriched_results.append(
                    {
                        "title": url,
                        "url": url,
                        "scraped_content": "Failed to scrape content",
                        "token_count": 0,
                    }
                )
            else:
                content = scraped_contents[i]
                token_count = self._count_tokens(content)

                enriched_results.append(
                    {
                        "title": url,
                        "url": url,
                        "scraped_content": content,
                        "token_count": token_count,
                    }
                )

                # Check if we need to summarize this content
                if token_count > settings.SUMMARIZATION_TOKEN_THRESHOLD:
                    summarization_tasks.append(
                        self.summarize_webpage_service.summarize_webpage(
                            content, search_term
                        )
                    )
                    indices_to_summarize.append(i)

        # If there are contents that need summarization
        if summarization_tasks:
            summaries = await asyncio.gather(
                *summarization_tasks, return_exceptions=True
            )

            # Update the enriched results with individual summaries
            for i, summary_idx in enumerate(indices_to_summarize):
                if isinstance(summaries[i], Exception):
                    # Keep original content if summarization failed
                    pass
                else:
                    # Replace the original content with the summary
                    enriched_results[summary_idx]["scraped_content"] = (
                        summaries[i]
                    )

        # Return the combined results
        return json.dumps(
            {"query": search_term, "results": enriched_results}, indent=2
        )
