from pydantic import ConfigDict
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ANTHROPIC_API_KEY: str
    ANTHROPIC_MODEL: str = "claude-sonnet-4-20250514"
    ANTHROPIC_BASE_URL: str = "https://api.anthropic.com/v1/messages"
    ANTHROPIC_MAX_RETRIES: int = 3
    ANTHROPIC_MAX_TOOL_CALL_DEPTH: int = 100
    SERVER_URL: str = "http://0.0.0.0:8001/sse"

    # OpenAI API for summarization
    OPENAI_API_KEY: str
    OPENAI_MODEL: str = "gpt-4.1-mini-2025-04-14"
    OPENAI_BASE_URL: str = "https://api.openai.com/v1/chat/completions"

    MONGODB_URL: str = "mongodb://localhost:27017"
    MONGODB_DB_NAME: str = "code_assistant"
    LLM_USAGE_COLLECTION_NAME: str = "llm_usage_logs"

    model_config = ConfigDict(
        env_file=".env", extra="ignore"  # Allow extra fields from .env file
    )


settings = Settings()
