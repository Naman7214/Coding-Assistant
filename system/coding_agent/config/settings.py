from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ANTHROPIC_API_KEY: str
    ANTHROPIC_MODEL: str = "claude-sonnet-4-20250514"
    ANTHROPIC_BASE_URL: str = "https://api.anthropic.com/v1/messages"
    ANTHROPIC_TIMEOUT: int = 100
    ANTHROPIC_MAX_RETRIES: int = 3
    ANTHROPIC_MAX_TOOL_CALL_DEPTH: int = 100
    ANTHROPIC_MAX_RETRIES: int = 3
    MCP_BASE_URL: str = "http://0.0.0.0:8001/sse"

    MONGODB_URL: str = "mongodb://localhost:27017"
    MONGODB_DB_NAME: str = "code_assistant"
    LLM_USAGE_COLLECTION_NAME: str = "llm_usage_logs"

    class Config:
        env_file = ".env"


settings = Settings()
