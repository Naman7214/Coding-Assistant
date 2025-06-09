from pydantic import BaseModel


class CodeBaseSearchQueryRequest(BaseModel):
    query: str
    explanation: str
    hashed_workspace_path: str
    git_branch: str = "default"
