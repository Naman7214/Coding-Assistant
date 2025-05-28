from typing import Optional

from pydantic import BaseModel, Field


class RunTerminalCommandRequest(BaseModel):
    cmd: str
    is_background: bool
    workspace_path: str = Field(
        ..., description="The path to the workspace to run the command in"
    )
    explanation: Optional[str] = None
