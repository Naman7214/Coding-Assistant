from datetime import datetime
from typing import Any, Dict, List, Optional


class Chunk:
    def __init__(
        self,
        chunk_hash: str,
        content: str,
        obfuscated_path: str,
        start_line: int,
        end_line: int,
        language: str,
        chunk_type: str,
        git_branch: str,
        token_count: int,
        embedding: Optional[List[float]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        created_at: Optional[datetime] = None,
        updated_at: Optional[datetime] = None,
    ):
        self.chunk_hash = chunk_hash
        self.content = content
        self.obfuscated_path = obfuscated_path
        self.start_line = start_line
        self.end_line = end_line
        self.language = language
        self.chunk_type = chunk_type
        self.git_branch = git_branch
        self.token_count = token_count
        self.embedding = embedding
        self.metadata = metadata or {}
        self.created_at = created_at or datetime.now()
        self.updated_at = updated_at or datetime.now()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chunk_hash": self.chunk_hash,
            "content": self.content,
            "obfuscated_path": self.obfuscated_path,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "language": self.language,
            "chunk_type": self.chunk_type,
            "git_branch": self.git_branch,
            "token_count": self.token_count,
            "embedding": self.embedding,
            "metadata": self.metadata,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
            "updated_at": (
                self.updated_at.isoformat() if self.updated_at else None
            ),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Chunk":
        created_at = None
        if data.get("created_at"):
            if isinstance(data["created_at"], str):
                created_at = datetime.fromisoformat(data["created_at"])
            else:
                created_at = data["created_at"]

        updated_at = None
        if data.get("updated_at"):
            if isinstance(data["updated_at"], str):
                updated_at = datetime.fromisoformat(data["updated_at"])
            else:
                updated_at = data["updated_at"]

        return cls(
            chunk_hash=data["chunk_hash"],
            content=data["content"],
            obfuscated_path=data["obfuscated_path"],
            start_line=data["start_line"],
            end_line=data["end_line"],
            language=data["language"],
            chunk_type=data["chunk_type"],
            git_branch=data["git_branch"],
            token_count=data["token_count"],
            embedding=data.get("embedding"),
            metadata=data.get("metadata", {}),
            created_at=created_at,
            updated_at=updated_at,
        )
