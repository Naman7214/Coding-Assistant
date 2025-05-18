from functools import wraps

from fastapi import HTTPException, status
from fastapi.responses import JSONResponse


def handle_exceptions(func):
    """A decorator to catch exceptions and return a consistent JSON error response."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            result = await func(*args, **kwargs)
            return result
        except Exception as e:
            # If it's already a response, don't wrap it again
            if isinstance(e, HTTPException):
                raise e

            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={
                    "data": {},
                    "statuscode": 500,
                    "detail": "An internal server error occurred.",
                    "error": str(e),
                },
            )

    return wrapper
