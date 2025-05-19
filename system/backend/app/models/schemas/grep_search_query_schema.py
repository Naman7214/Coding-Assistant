from pydantic import BaseModel, Field


class GrepSearchQueryRequest(BaseModel):
    query: str
    case_sensitive: bool = Field(ault=False)
    include_pattern: str | None = Field(ault=None)
    exclude_pattern: str | None = Field(ault=None)
    explanation: str | None = Field(ault=None)
