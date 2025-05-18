from fastapi import Depends, HTTPException

from backend.app.config.database import mongodb_database
from backend.app.models.domain.error import Error


class ErrorRepo:
    def __init__(
        self, collection=Depends(mongodb_database.get_error_collection)
    ) -> None:
        self.collection = collection

    async def insert_error(self, error: Error) -> None:
        insert_result = await self.collection.insert_one(error.to_dict())
        if not insert_result.inserted_id:
            raise HTTPException(
                status_code=500,
                detail="Failed to insert complaint. \n error from error_repository in insert_error()",
            )
        return insert_result
