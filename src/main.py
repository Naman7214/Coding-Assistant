from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.app.apis import (
    code_base_search_route,
    run_terminal_cmd_route,
    web_search_route,
)
from src.app.config.database import mongodb_database
from src.app.apis.file_access_routes import router as file_access_router


@asynccontextmanager
async def db_lifespan(app: FastAPI):
    mongodb_database.connect()

    yield

    mongodb_database.disconnect()


app = FastAPI(title="My FastAPI Application", lifespan=db_lifespan)
app.include_router(
    code_base_search_route.router, prefix="/api/v1", tags=["search tools"]
)
app.include_router(
    web_search_route.router, prefix="/api/v1", tags=["external tools"]
)
app.include_router(
    run_terminal_cmd_route.router, prefix="/api/v1", tags=["enviornment tools"]
)
# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(file_access_router)

@app.get("/")
async def root():
    return {"message": "Welcome to my FastAPI application!"}


if __name__ == "__main__":
    uvicorn.run("src.main:app", host="0.0.0.0", port=8000, reload=True)
