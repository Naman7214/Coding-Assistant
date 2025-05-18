from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ANTHROPIC_API_KEY: str
    ANTHROPIC_MODEL: str = "claude-3-7-sonnet-20250219"
    ANTHROPIC_BASE_URL: str = "https://api.anthropic.com/v1/messages"
    ANTHROPIC_TIMEOUT: int = 100
    ANTHROPIC_MAX_RETRIES: int = 3
    ANTHROPIC_MAX_TOOL_CALL_DEPTH: int = 25
    ANTHROPIC_MAX_RETRIES: int = 3
    MCP_BASE_URL: str = "http://0.0.0.0:8001/sse"

    class Config:
        env_file = ".env"


settings = Settings()
