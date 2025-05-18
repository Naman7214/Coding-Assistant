from typing import Optional

from pydantic import BaseModel


class RunTerminalCommandRequest(BaseModel):
    cmd: str
    is_background: bool
    explanation: Optional[str] = None
