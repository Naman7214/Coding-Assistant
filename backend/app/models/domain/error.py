from datetime import datetime

from pydantic import BaseModel, Field


class Error(BaseModel):
    tool_name: str
    error_message: str
    timestamp: str = Field(default=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    def to_dict(self):
        return self.model_dump()
