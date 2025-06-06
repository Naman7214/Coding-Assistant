from typing import Any, Dict, List, Optional

from models.schema.context_schema import ActiveFileContext, SystemInfo
from pydantic import BaseModel


class QueryRequest(BaseModel):
    query: str
    workspace_path: str
    system_info: Optional[SystemInfo] = None
    active_file_context: Optional[ActiveFileContext] = None
    context_mentions: Optional[List[str]] = None


class PermissionResponse(BaseModel):
    permission_id: str
    granted: bool


class StreamEvent(BaseModel):
    type: str  # "thinking", "assistant_response", "tool_selection", "tool_execution", "tool_result", "final_response", "permission_request", "context_request"
    content: str
    metadata: Optional[Dict[str, Any]] = None
    timestamp: float
