import time
from datetime import datetime

import httpx
import tiktoken
from fastapi import Depends

from backend.app.config.settings import settings
from backend.app.prompts.webpage_summarizer_prompt import (
    WEB_PAGE_SUMMARIZER_PROMPT,
)
from backend.app.repositories.llm_usage_repo import LLMUsageRepository


class SummarizeWebpageService:
    def __init__(
        self, llm_usage_repo: LLMUsageRepository = Depends(LLMUsageRepository)
    ):
        self.encoding = tiktoken.get_encoding("cl100k_base")
        self.timeout = httpx.Timeout(
            connect=60.0,  # Time to establish a connection
            read=120.0,  # Time to read the response
            write=120.0,  # Time to send data
            pool=60.0,  # Time to wait for a connection from the pool
        )
        self.llm_usage_repo = llm_usage_repo

    async def summarize_webpage(
        self, scraped_content: str, search_term: str
    ) -> str:
        """
        Summarize scraped content using OpenAI's API.

        Args:
            scraped_content: Content to summarize
            search_term: The original search term

        Returns:
            Summarized response from OpenAI
        """
        url = settings.OPENAI_BASE_URL
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        }

        # Construct the prompt
        prompt = WEB_PAGE_SUMMARIZER_PROMPT.format(
            search_term=search_term, scraped_content=scraped_content
        )

        data = {
            "model": settings.OPENAI_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a helpful assistant that summarizes web content accurately.",
                },
                {"role": "user", "content": prompt},
            ],
        }

        async with httpx.AsyncClient(
            verify=False, timeout=self.timeout
        ) as client:

            start_time = time.perf_counter()

            response = await client.post(url, headers=headers, json=data)
            response.raise_for_status()
            response = response.json()

            end_time = time.perf_counter()
            duration = end_time - start_time

            usage = response.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)
            total_tokens = usage.get("total_tokens", 0)
            llm_usage = {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
                "duration": duration,
                "provider": "OpenAI",
                "model": settings.OPENAI_MODEL,
                "created_at": datetime.utcnow(),
            }
            await self.llm_usage_repo.add_llm_usage(llm_usage)

            # Extract the assistant's response
            if "choices" in response and len(response["choices"]) > 0:
                return response["choices"][0]["message"]["content"]
            else:
                return "No summary could be generated."
