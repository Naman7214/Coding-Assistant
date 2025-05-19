from crawl4ai import AsyncWebCrawler

from system.backend.app.config.scrape_webpage_config import (
    browser_conf,
    crawler_cfg,
)


class ScrapeWebpagesService:
    def __init__(self):
        pass

    async def scrape_web_page(self, url: str) -> str:
        async with AsyncWebCrawler(config=browser_conf) as crawler:
            result = await crawler.arun(url=url, config=crawler_cfg)
            return result.markdown
