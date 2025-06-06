import httpx
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    RUN_CMD_API: str
    WEB_SEARCH_API: str
    READ_FILE_API: str
    DELETE_FILE_API: str
    LIST_DIR_API: str
    SEARCH_FILES_API: str
    SEARCH_AND_REPLACE_API: str
    REAPPLY_API: str
    CODEBASE_SEARCH_API: str
    EXECUTE_GREP_SEARCH_API: str
    EDIT_FILE_API: str

    class Config:
        env_file = ".env"
        extra = "allow"

    @property
    def httpx_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=60.0,
            read=150.0,
            write=150.0,
            pool=60.0,
        )


settings = Settings()
