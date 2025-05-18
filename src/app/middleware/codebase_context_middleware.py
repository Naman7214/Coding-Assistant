from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from src.app.utils.codebase_context_utils import codebase_context

class CodebaseContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Extract the codebase path from the request header
        codebase_path = request.headers.get("codebase-path")
        
        # Set the token in the context
        if codebase_path:
            token = codebase_context.set(codebase_path)
            try:
                # Process the request
                response = await call_next(request)
                return response
            finally:
                # Reset the context after the request is processed
                codebase_context.reset(token)
        else:
            # If no codebase path is provided, just process the request
            return await call_next(request)
        
        
    
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