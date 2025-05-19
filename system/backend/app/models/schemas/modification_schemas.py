from typing import List, Optional

from pydantic import BaseModel, Field


class SearchReplaceOptions(BaseModel):
    case_sensitive: bool = Field(
        default=True, description="Whether the search should be case sensitive"
    )
    include_pattern: str = Field(
        default="*", description="Glob pattern for files to include"
    )
    exclude_pattern: str = Field(
        default="", description="Glob pattern for files to exclude"
    )
    search_paths: List[str] = Field(
        default=[], description="Paths to search in"
    )


class SearchReplaceRequest(BaseModel):
    query: str = Field(
        ..., description="The text or regex pattern to search for"
    )
    replacement: str = Field(
        ..., description="The text to replace the matched content with"
    )
    options: Optional[SearchReplaceOptions] = Field(
        default=None, description="Search options"
    )
    explanation: str = Field(
        ..., description="The explanation for the search and replace request"
    )


class EditFileRequest(BaseModel):
    target_file_path: str = Field(
        ..., description="The path to the file to edit"
    )
    code_snippet: str = Field(..., description="The code snippet to edit")
    explanation: str = Field(
        ..., description="The explanation for the file edit request"
    )


class ReapplyRequest(BaseModel):
    target_file_path: str = Field(
        ..., description="The path to the file to reapply"
    )
    code_snippet: str = Field(..., description="The code snippet to reapply")
    explanation: str = Field(
        ..., description="The explanation for the file reapply request"
    )
