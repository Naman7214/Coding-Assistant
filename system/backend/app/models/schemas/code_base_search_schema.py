from pydantic import BaseModel, Field


class CodeBaseSearchQueryRequest(BaseModel):
    query: str
    explanation: str
    target_directories: list[str] = Field(default=[])
