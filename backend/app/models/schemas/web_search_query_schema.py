from typing import List

from pydantic import BaseModel


class WebSearchQueryRequest(BaseModel):
    search_term: str
    target_urls: List[str] = []
    explanation: str = ""
