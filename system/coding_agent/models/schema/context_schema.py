from typing import Dict, List

from pydantic import BaseModel


class SystemInfo(BaseModel):
    platform: str
    osVersion: str
    architecture: str
    workspacePath: str
    defaultShell: str


class FileInfo(BaseModel):
    path: str
    languageId: str
    lineCount: int
    fileSize: int
    lastModified: str


class CursorPosition(BaseModel):
    line: int
    character: int


class Selection(BaseModel):
    line: int
    character: int


class CursorContext(BaseModel):
    line: int
    character: int
    selection: List[Selection]
    lineContent: Dict[str, str]  # keys: current, above, below


class ViewportRange(BaseModel):
    line: int
    character: int


class Viewport(BaseModel):
    visibleRanges: List[List[ViewportRange]]
    startLine: int
    endLine: int


class ActiveFileContext(BaseModel):
    file: FileInfo
    cursor: CursorContext
    viewport: Viewport


class OpenFileInfo(BaseModel):
    path: str
    languageId: str
    lineCount: int
    fileSize: int
    lastModified: str


class EditChange(BaseModel):
    type: str  # "addition", "deletion", "modification"
    startLine: int
    endLine: int
    content: List[str]


class FileEdit(BaseModel):
    filePath: str
    relativePath: str
    changes: List[EditChange]
    changeType: str
    lastModified: str


class FileOperation(BaseModel):
    filePath: str
    relativePath: str
    changeType: str  # "added", "deleted"
    lastModified: str


class EditsSummary(BaseModel):
    hasChanges: bool
    timeWindow: str
    totalFiles: int
    checkInterval: int


class RecentEditsContext(BaseModel):
    summary: EditsSummary
    modifiedFiles: List[FileEdit]
    addedFiles: List[FileOperation]
    deletedFiles: List[FileOperation]
    timestamp: int
    gitBranch: str
    workspaceHash: str
