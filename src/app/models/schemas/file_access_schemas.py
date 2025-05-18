from pydantic import BaseModel, Field


class FileReadRequest(BaseModel):
    file_path: str = Field(..., description="The path to the file to read")
    start_line: int = Field(
        default=None, description="The line number to start reading from"
    )
    end_line: int = Field(
        default=None, description="The line number to stop reading at"
    )
    explanation: str = Field(
        ..., description="The explanation for the file read request"
    )


class FilesDeleteRequest(BaseModel):
    path: str = Field(..., description="The path to the file to delete")
    explanation: str = Field(
        ..., description="The explanation for the file deletion request"
    )


class DirectoryListRequest(BaseModel):
    dir_path: str = Field(
        default="",
        description="The path to the directory to list, defaults to current directory if not provided",
    )
    recursive: bool = Field(
        default=True, description="Whether to list subdirectories recursively"
    )
    explanation: str = Field(
        ..., description="The explanation for the directory list request"
    )


class FileSearchRequest(BaseModel):
    pattern: str = Field(
        ..., description="The pattern to search for in file names"
    )
    explanation: str = Field(
        ..., description="The explanation for the file search request"
    )
