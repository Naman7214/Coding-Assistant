from pydantic_settings import BaseSettings


class Settings(BaseSettings):

    # MongoDB settings
    MONGODB_URL: str = "mongodb://localhost:27017"
    MONGODB_DB_NAME: str = "code_assistant"
    ERROR_COLLECTION_NAME: str = "error_logs"
    LLM_USAGE_COLLECTION_NAME: str = "llm_usage_logs"
    VOYAGEAI_API_KEY: str
    VOYAGEAI_BASE_URL: str

    # MEM0_API_KEY:  str


    # Pinecone settings
    PINECONE_CREATE_INDEX_URL: str = "https://api.pinecone.io/indexes"
    PINECONE_API_VERSION: str = "2025-01"
    PINECONE_EMBED_URL: str = "https://api.pinecone.io/embed"
    PINECONE_UPSERT_URL: str = "https://{}/vectors/upsert"
    PINECONE_RERANK_URL: str = "https://api.pinecone.io/rerank"
    PINECONE_QUERY_URL: str = "https://{}/query"
    PINECONE_LIST_INDEXES_URL: str = "https://api.pinecone.io/indexes"
    PINECONE_API_KEY: str
    PINECONE_INDEX_NAME: str = "n8n-examples"
    PINECONE_SIMILARITY_THRESHOLD: float = 0.56
    OPENAI_API_KEY: str
    ANTHROPIC_API_KEY: str
    OPENAI_BASE_URL: str = "https://api.openai.com/v1/chat/completions"
    OPENAI_MODEL: str = "gpt-4.1-mini-2025-04-14"
    TAVILY_API_KEY: str

    # Chunking service settings
    CHUNKS_OUTPUT_PATH: str = "chunks"
    CHUNK_TOKEN_LIMIT: int = 500
    CHUNK_OVERLAP: int = 50
    CHUNKS_OUTPUT_FILENAME: str = "mern_codebase_chunks.json"
    IGNORE_DIRECTORIES: list = [
        ".venv",
        "node_modules",
        ".git",
        "__pycache__",
        "venv",
        "env",
        "dist",
        "build",
    ]
    IGNORE_FILES: list = [
        "README.md",
        "readme.md",
        "package.json",
        "package-lock.json",
        "yarn.lock",
    ]

    # Codebase indexing settings
    INDEXING_CHUNK_SIZE: int = 90
    INDEXING_UPSERT_BATCH_SIZE: int = 90
    INDEXING_PROCESS_BATCH_SIZE: int = 90
    INDEXING_DIMENSION: int = 1024
    INDEXING_SIMILARITY_METRIC: str = "dotproduct"
    INDEXING_EMBED_MODEL_NAME: str = "voyage-code-3"
    INDEXING_SEMAPHORE_VALUE: int = 5

    # CODEBASE_DIR: str = "/Users/krishgoyani/Developer/Code-Generation-Assistant/codebase"
    SUMMARIZATION_TOKEN_THRESHOLD: int = 3500

    CODEBASE_DIR: str = (
        "/Users/vinithachilkamari/Developer/n8n_frontend"
    )

    class Config:
        env_file = ".env"


settings = Settings()
