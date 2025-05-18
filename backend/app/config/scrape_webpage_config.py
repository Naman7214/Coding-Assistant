from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

prune_filter = PruningContentFilter(
    threshold_type="dynamic",
)

md_generator = DefaultMarkdownGenerator(
    content_filter=prune_filter,
    options={
        "ignore_links": True,
        "escape_html": True,
        "ignore_images": True,
        "skip_internal_links": True,
    },
)
crawler_cfg = CrawlerRunConfig(
    exclude_external_links=True,
    exclude_social_media_links=True,
    exclude_external_images=True,
    verbose=False,
    cache_mode=CacheMode.DISABLED,
    markdown_generator=md_generator,
)
browser_conf = BrowserConfig(text_mode=True, light_mode=True, verbose=False)
