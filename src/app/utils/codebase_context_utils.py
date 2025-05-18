from contextvars import ContextVar

# Create a context variable to store the request
codebase_context: ContextVar[str] = ContextVar(
    "codebase_context", default=None
)

thread_context: ContextVar[str] = ContextVar(
    "thread_context", default=None
)