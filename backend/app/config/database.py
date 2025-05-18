from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

from backend.app.config.settings import settings


class MongoDB:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.mongodb_client = None

    def connect(self):
        try:
            self.mongodb_client = AsyncIOMotorClient(
                self.database_url, maxpoolsize=30, minpoolsize=5
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Unable to connect to MongoDB: {str(e)} \n error while connecting to MongoDB (from database.py in connect())",
            )

    def get_mongo_client(self):
        if not self.mongodb_client:
            raise HTTPException(
                status_code=503,
                detail="MongoDB client is not connected. \n error while connecting to MongoDB client in database.py in get_mongo_client()",
            )
        return self.mongodb_client

    def get_error_collection(self):
        try:
            if not self.mongodb_client:
                raise HTTPException(
                    status_code=503,
                    detail="MongoDB client is not connected. \n error while connecting to MongoDB client in database.py in get_error_collection()",
                )
            return self.mongodb_client[settings.MONGODB_DB_NAME][
                settings.ERROR_COLLECTION_NAME
            ]
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Unable to access auth collection: {str(e)} \n error while accessing auth collection (from database.py in get_error_collection())",
            )

    def get_llm_usage_collection(self):
        try:
            if not self.mongodb_client:
                raise HTTPException(
                    status_code=503,
                    detail="MongoDB client is not connected. \n error while connecting to MongoDB client (from database.py in get_llm_usage_collection())",
                )
            return self.mongodb_client[settings.MONGODB_DB_NAME][
                settings.LLM_USAGE_COLLECTION_NAME
            ]
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Unable to access auth collection: {str(e)} \n error while connecting to MongoDB client (from database.py in get_llm_usage_collection())",
            )

    def disconnect(self):
        try:
            if self.mongodb_client:
                self.mongodb_client.close()
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Unable to close MongoDB connection: {str(e)} \n error while disconnecting MongoDB (from database.py in discconect())",
            )


# Instantiate the MongoDB class
mongodb_database = MongoDB(settings.MONGODB_URL)
