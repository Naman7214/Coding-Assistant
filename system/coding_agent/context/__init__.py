"""
Context module for Code Generation Assistant

This module provides context retrieval capabilities using HTTP API
to communicate with the VS Code extension's context management system.
"""

from .http_context_adapter import HTTPContextAdapter, ContextRetriever
from .streaming_context_client import StreamingContextClient, ContextManager, ContextData

__all__ = [
    'HTTPContextAdapter',
    'ContextRetriever',  # Backward compatibility alias
    'StreamingContextClient', 
    'ContextManager',
    'ContextData'
] 