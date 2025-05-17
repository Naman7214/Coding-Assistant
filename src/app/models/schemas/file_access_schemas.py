from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

class FileReadRequest(BaseModel):
    file_path: str = Field(..., description="The path to the file to read")
    start_line: int = Field(default=None, description="The line number to start reading from")
    end_line: int = Field(default=None, description="The line number to stop reading at")
    explanation: str = Field(..., description="The explanation for the file read request")
    
class FilesDeleteRequest(BaseModel):
    path: str = Field(..., description="The path to the file to delete")
    explanation: str = Field(..., description="The explanation for the file deletion request")

class DirectoryListRequest(BaseModel):
    dir_path: str = Field(default="", description="The path to the directory to list, defaults to current directory if not provided")
    recursive: bool = Field(default=True, description="Whether to list subdirectories recursively")
    explanation: str = Field(..., description="The explanation for the directory list request")

class FileSearchRequest(BaseModel):
    pattern: str = Field(..., description="The pattern to search for in file names")
    explanation: str = Field(..., description="The explanation for the file search request")

class SearchReplaceOptions(BaseModel):
    case_sensitive: bool = Field(default=True, description="Whether the search should be case sensitive")
    include_pattern: str = Field(default="*", description="Glob pattern for files to include")
    exclude_pattern: str = Field(default="", description="Glob pattern for files to exclude")
    search_paths: List[str] = Field(default=["./"], description="Paths to search in")

class SearchReplaceRequest(BaseModel):
    query: str = Field(..., description="The text or regex pattern to search for")
    replacement: str = Field(..., description="The text to replace the matched content with")
    options: Optional[SearchReplaceOptions] = Field(default=None, description="Search options")
    explanation: str = Field(..., description="The explanation for the search and replace request")