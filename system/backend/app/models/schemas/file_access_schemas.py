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
    workspace_path: str = Field(..., description="The path to the workspace")


class FilesDeleteRequest(BaseModel):
    path: str = Field(..., description="The path to the file to delete")
    explanation: str = Field(
        ..., description="The explanation for the file deletion request"
    )
    workspace_path: str = Field(..., description="The path to the workspace")



class FileSearchRequest(BaseModel):
    pattern: str = Field(
        ..., description="The pattern to search for in file names"
    )
    workspace_path: str = Field(..., description="The path to the workspace")
    explanation: str = Field(
        ..., description="The explanation for the file search request"
    )
