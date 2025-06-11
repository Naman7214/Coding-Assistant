from typing import Optional

from pydantic import BaseModel, Field


class RunTerminalCommandRequest(BaseModel):
    cmd: str
    is_background: bool = False
    workspace_path: str = Field(
        default=None, description="The path to the workspace"
    )
    explanation: Optional[str] = None
