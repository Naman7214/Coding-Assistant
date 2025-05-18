from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from src.app.utils.codebase_context_utils import thread_context


class ThreadContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Extract the thread_id from the request header
        thread_id = request.headers.get("thread-id")

        # Set the token in the context
        if thread_id:
            token = thread_context.set(thread_id)
            try:
                # Process the request
                response = await call_next(request)
                return response
            finally:
                # Reset the context after the request is processed
                thread_context.reset(token)
        else:
            # If no thread_id is provided, just process the request
            return await call_next(request)
