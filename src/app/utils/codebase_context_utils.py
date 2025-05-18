from contextvars import ContextVar

thread_context: ContextVar[str] = ContextVar("thread_context", default=None)
