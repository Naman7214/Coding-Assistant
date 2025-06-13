import traceback

from fastapi import Depends

from system.backend.app.config.database import mongodb_database
from system.backend.app.models.domain.error import Error


class ErrorRepo:
    def __init__(
        self, collection=Depends(mongodb_database.get_error_collection)
    ) -> None:
        self.collection = collection

    async def insert_error(self, error: Error) -> None:
        try:
            # Automatically capture stack trace if not already provided
            if error.stack_trace is None:
                # Get the current stack trace, excluding this method call
                stack_frames = traceback.extract_stack()[:-1]
                error.stack_trace = "".join(traceback.format_list(stack_frames))

            insert_result = await self.collection.insert_one(error.to_dict())
            if not insert_result.inserted_id:
                pass
        except Exception as e:
            pass
        return insert_result
