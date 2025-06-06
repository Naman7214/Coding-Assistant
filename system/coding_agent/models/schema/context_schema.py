from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class SystemInfo(BaseModel):
    platform: str
    osVersion: str
    architecture: str
    workspacePath: str
    defaultShell: str


class ActiveFileContext(BaseModel):
    path: Optional[str] = None
    relativePath: Optional[str] = None
    languageId: Optional[str] = None
    lineCount: Optional[int] = None
    fileSize: Optional[int] = None
    lastModified: Optional[str] = None
    content: Optional[str] = None
    cursorPosition: Optional[Dict[str, Any]] = None
    selection: Optional[Dict[str, Any]] = None
    visibleRanges: Optional[List[Dict[str, Any]]] = None
    cursorLineContent: Optional[Dict] = None
