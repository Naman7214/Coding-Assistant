from pydantic import BaseModel, Field


class GrepSearchQueryRequest(BaseModel):
    query: str
    case_sensitive: bool = Field(default=False)
    include_pattern: str | None = Field(default=None)
    exclude_pattern: str | None = Field(default=None)
    explanation: str | None = Field(default=None)
