import os
from typing import Optional, Dict, Any

from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    """
    Configuration settings for the agent component.
    """
    # MCP Server settings
    MCP_BASE_URL: str = os.getenv("MCP_BASE_URL", "http://localhost:8000")
    
    # Claude API settings
    CLAUDE_API_KEY: str
    CLAUDE_MODEL: str
    CLAUDE_BASE_URL: str
    CLAUDE_MESSAGES_ENDPOINT: str
    ANTHROPIC_VERSION: str
    OPENAI_MODEL : str  = "gpt-4.1-mini-2025-04-14"
    OPENAI_API_KEY : str
    
    # Agent workflow settings
    MAX_TOOL_CALLS_PER_SESSION: int = int(os.getenv("MAX_TOOL_CALLS_PER_SESSION", 25))
    
    # MongoDB settings
    MONGODB_URI: str = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    MONGODB_DB_NAME: str = os.getenv("MONGODB_DB_NAME", "agent_memory")
    MONGODB_CONVERSATION_COLLECTION: str = os.getenv("MONGODB_CONVERSATION_COLLECTION", "conversations")
    
    # Logging settings
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_FORMAT: str = os.getenv("LOG_FORMAT", "%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


# Create a settings instance
settings = Settings()

# Configure logging
import logging

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL),
    format=settings.LOG_FORMAT
)

# Suppress verbose logging from libraries
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)