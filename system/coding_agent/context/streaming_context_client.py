"""
Streaming Context Client for Code Generation Assistant

This module provides a client for fetching context from the VS Code extension's
HTTP API server with streaming support and chunk reassembly.
"""

import json
import logging
import time
import asyncio
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, AsyncGenerator
from urllib.parse import urljoin
import aiohttp
import httpx
from collections import defaultdict


logger = logging.getLogger(__name__)


@dataclass
class StreamingChunk:
    """Represents a single chunk from the streaming API"""
    id: str
    type: str
    data: Any
    chunk_index: int
    total_chunks: int
    workspace_id: str


@dataclass 
class ContextData:
    """Complete context data assembled from chunks"""
    workspace_id: str
    workspace: Optional[Dict] = None
    active_file: Optional[Dict] = None
    open_files: List[Dict] = field(default_factory=list)
    project_structure: Optional[Dict] = None
    git_context: Optional[Dict] = None
    total_tokens: int = 0
    timestamp: Optional[str] = None
    
    def is_complete(self) -> bool:
        """Check if all required context pieces are present"""
        return all([
            self.workspace is not None,
            self.project_structure is not None,
            # active_file and git_context can be None
        ])


class StreamingContextClient:
    """
    HTTP client for fetching context from VS Code extension with streaming support
    
    Features:
    - Server-Sent Events (SSE) for streaming large contexts
    - Automatic chunk reassembly
    - Fallback to regular HTTP for smaller contexts
    - Connection health monitoring
    - Retry logic with exponential backoff
    """
    
    def __init__(
        self,
        base_url: str = "http://localhost:3001",
        timeout: int = 60,
        max_retries: int = 3,
        chunk_timeout: int = 10
    ):
        self.base_url = base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self.chunk_timeout = chunk_timeout
        self.session: Optional[httpx.AsyncClient] = None
        self._health_cache: Dict[str, Any] = {}
        self._health_cache_ttl = 30  # seconds
        
    async def __aenter__(self):
        """Async context manager entry"""
        self.session = httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout),
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
        )
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if self.session:
            await self.session.aclose()
            self.session = None
    
    async def health_check(self, force_check: bool = False) -> Dict[str, Any]:
        """
        Check if the VS Code extension API server is healthy
        
        Args:
            force_check: Skip cache and force a fresh health check
            
        Returns:
            Health status dictionary
        """
        cache_key = "health"
        current_time = time.time()
        
        # Return cached result if valid and not forced
        if not force_check and cache_key in self._health_cache:
            cached_health, cache_time = self._health_cache[cache_key]
            if current_time - cache_time < self._health_cache_ttl:
                return cached_health
        
        try:
            if not self.session:
                raise ConnectionError("Client session not initialized")
                
            url = urljoin(self.base_url, "/api/health")
            response = await self.session.get(url)
            response.raise_for_status()
            
            health_data = response.json()
            self._health_cache[cache_key] = (health_data, current_time)
            
            logger.info(f"Extension API health check passed: {health_data.get('status', 'unknown')}")
            return health_data
            
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            error_health = {
                "success": False,
                "status": "unhealthy",
                "error": str(e),
                "timestamp": time.time()
            }
            self._health_cache[cache_key] = (error_health, current_time)
            return error_health
    
    async def get_context_streaming(
        self,
        workspace_id: str,
        max_tokens: int = 50000,
        force_refresh: bool = False
    ) -> ContextData:
        """
        Get context using Server-Sent Events streaming API
        
        Args:
            workspace_id: Workspace identifier
            max_tokens: Maximum token limit for context
            force_refresh: Force fresh context collection (bypass cache)
            
        Returns:
            Complete assembled context data
        """
        logger.info(f"Fetching streaming context for workspace: {workspace_id}")
        
        if not self.session:
            raise ConnectionError("Client session not initialized")
        
        url = urljoin(self.base_url, f"/api/workspace/{workspace_id}/context/stream")
        params = {
            "maxTokens": max_tokens,
            "forceRefresh": str(force_refresh).lower()
        }
        
        context_data = ContextData(workspace_id=workspace_id)
        chunks_received = defaultdict(bool)  # Track which chunk types we've received
        
        try:
            async with self.session.stream(
                "GET", 
                url, 
                params=params,
                headers={"Accept": "text/event-stream"}
            ) as response:
                response.raise_for_status()
                
                async for chunk in self._parse_sse_stream(response):
                    await self._process_streaming_chunk(chunk, context_data, chunks_received)
                    
                    # Check if we've received completion event
                    if chunk.get("event") == "complete":
                        context_data.timestamp = chunk.get("data", {}).get("timestamp")
                        context_data.total_tokens = chunk.get("data", {}).get("totalTokens", 0)
                        break
                
                logger.info(f"Streaming context fetch completed. Tokens: {context_data.total_tokens}")
                return context_data
                
        except Exception as e:
            logger.error(f"Streaming context fetch failed: {e}")
            # Fallback to regular HTTP endpoint
            logger.info("Falling back to legacy HTTP endpoint...")
            return await self.get_context_legacy(workspace_id, max_tokens)
    
    async def get_context_legacy(
        self,
        workspace_id: str,
        max_tokens: int = 50000
    ) -> ContextData:
        """
        Fallback method using regular HTTP endpoint
        
        Args:
            workspace_id: Workspace identifier
            max_tokens: Maximum token limit for context
            
        Returns:
            Context data from legacy endpoint
        """
        logger.info(f"Fetching legacy context for workspace: {workspace_id}")
        
        if not self.session:
            raise ConnectionError("Client session not initialized")
        
        url = urljoin(self.base_url, f"/api/workspace/{workspace_id}/context")
        params = {"maxTokens": max_tokens}
        
        try:
            response = await self.session.get(url, params=params)
            response.raise_for_status()
            
            data = response.json()
            if not data.get("success"):
                raise ValueError(f"API returned error: {data.get('error', 'Unknown error')}")
            
            context_dict = data.get("context", {})
            
            # Convert to ContextData format
            context_data = ContextData(
                workspace_id=workspace_id,
                workspace=context_dict.get("workspace"),
                active_file=context_dict.get("activeFile"),
                open_files=context_dict.get("openFiles", []),
                project_structure=context_dict.get("projectStructure"),
                git_context=context_dict.get("gitContext"),
                total_tokens=context_dict.get("totalTokens", 0),
                timestamp=data.get("timestamp")
            )
            
            logger.info(f"Legacy context fetch completed. Tokens: {context_data.total_tokens}")
            return context_data
            
        except Exception as e:
            logger.error(f"Legacy context fetch failed: {e}")
            raise
    
    async def get_context_with_retry(
        self,
        workspace_id: str,
        max_tokens: int = 50000,
        force_refresh: bool = False,
        prefer_streaming: bool = True
    ) -> ContextData:
        """
        Get context with automatic retry and fallback logic
        
        Args:
            workspace_id: Workspace identifier  
            max_tokens: Maximum token limit for context
            force_refresh: Force fresh context collection
            prefer_streaming: Try streaming first, fallback to legacy
            
        Returns:
            Context data
        """
        last_exception = None
        
        for attempt in range(self.max_retries):
            try:
                # Check health before attempting
                health = await self.health_check()
                if not health.get("success", False):
                    raise ConnectionError(f"API server unhealthy: {health.get('error', 'Unknown')}")
                
                # Try streaming first if preferred
                if prefer_streaming and attempt == 0:
                    try:
                        return await self.get_context_streaming(
                            workspace_id, max_tokens, force_refresh
                        )
                    except Exception as stream_error:
                        logger.warning(f"Streaming failed (attempt {attempt + 1}), trying legacy: {stream_error}")
                        last_exception = stream_error
                
                # Try legacy endpoint
                return await self.get_context_legacy(workspace_id, max_tokens)
                
            except Exception as e:
                last_exception = e
                wait_time = min(2 ** attempt, 8)  # Exponential backoff, max 8 seconds
                logger.warning(f"Context fetch attempt {attempt + 1} failed: {e}")
                
                if attempt < self.max_retries - 1:
                    logger.info(f"Retrying in {wait_time} seconds...")
                    await asyncio.sleep(wait_time)
                    
        raise last_exception or ConnectionError("All retry attempts failed")
    
    async def force_context_collection(self, workspace_id: str) -> Dict[str, Any]:
        """
        Force the extension to collect fresh context
        
        Args:
            workspace_id: Workspace identifier
            
        Returns:
            Collection result information
        """
        logger.info(f"Forcing context collection for workspace: {workspace_id}")
        
        if not self.session:
            raise ConnectionError("Client session not initialized")
        
        url = urljoin(self.base_url, f"/api/workspace/{workspace_id}/collect")
        
        try:
            response = await self.session.post(url)
            response.raise_for_status()
            
            data = response.json()
            if not data.get("success"):
                raise ValueError(f"Collection failed: {data.get('error', 'Unknown error')}")
            
            result = data.get("result", {})
            logger.info(f"Context collection completed in {result.get('duration', 0)}ms")
            return result
            
        except Exception as e:
            logger.error(f"Force collection failed: {e}")
            raise
    
    async def _parse_sse_stream(self, response) -> AsyncGenerator[Dict[str, Any], None]:
        """Parse Server-Sent Events stream"""
        buffer = ""
        
        async for chunk in response.aiter_text():
            buffer += chunk
            
            while "\n\n" in buffer:
                event_data, buffer = buffer.split("\n\n", 1)
                
                if not event_data.strip():
                    continue
                
                # Parse SSE format
                event = {}
                for line in event_data.split("\n"):
                    if ":" in line:
                        key, value = line.split(":", 1)
                        event[key.strip()] = value.strip()
                
                # Parse JSON data
                if "data" in event:
                    try:
                        event["data"] = json.loads(event["data"])
                    except json.JSONDecodeError:
                        logger.warning(f"Failed to parse SSE data as JSON: {event['data']}")
                
                yield event
    
    async def _process_streaming_chunk(
        self,
        sse_event: Dict[str, Any],
        context_data: ContextData,
        chunks_received: Dict[str, bool]
    ) -> None:
        """Process a single SSE event and update context data"""
        event_type = sse_event.get("event")
        data = sse_event.get("data", {})
        
        if event_type == "connection":
            logger.info(f"Connected to streaming API for workspace: {data.get('workspaceId')}")
            
        elif event_type == "status":
            logger.info(f"Status update: {data.get('message', 'Unknown')}")
            
        elif event_type == "chunk":
            chunk_type = data.get("type")
            chunk_data = data.get("data")
            
            if chunk_type == "workspace":
                context_data.workspace = chunk_data
                chunks_received["workspace"] = True
                logger.debug("Received workspace chunk")
                
            elif chunk_type == "activeFile":
                context_data.active_file = chunk_data
                chunks_received["activeFile"] = True
                logger.debug("Received active file chunk")
                
            elif chunk_type == "openFiles":
                context_data.open_files = chunk_data or []
                chunks_received["openFiles"] = True
                logger.debug(f"Received open files chunk: {len(context_data.open_files)} files")
                
            elif chunk_type == "projectStructure":
                context_data.project_structure = chunk_data
                chunks_received["projectStructure"] = True
                logger.debug("Received project structure chunk")
                
            elif chunk_type == "gitContext":
                context_data.git_context = chunk_data
                chunks_received["gitContext"] = True
                logger.debug("Received git context chunk")
                
        elif event_type == "error":
            error_msg = data.get("message", "Unknown streaming error")
            logger.error(f"Streaming error: {error_msg}")
            raise RuntimeError(f"Streaming API error: {error_msg}")
            
        elif event_type == "complete":
            logger.info("Streaming completed successfully")


# Context manager for easy usage
class ContextManager:
    """High-level context manager that wraps the streaming client"""
    
    def __init__(self, base_url: str = "http://localhost:3001"):
        self.base_url = base_url
        self.client: Optional[StreamingContextClient] = None
        
    async def __aenter__(self):
        self.client = StreamingContextClient(self.base_url)
        await self.client.__aenter__()
        return self
        
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.client:
            await self.client.__aexit__(exc_type, exc_val, exc_tb)
    
    async def get_context(
        self,
        workspace_id: str,
        max_tokens: int = 50000,
        force_refresh: bool = False
    ) -> ContextData:
        """Get context with automatic retry and health checking"""
        if not self.client:
            raise RuntimeError("Context manager not initialized")
            
        return await self.client.get_context_with_retry(
            workspace_id, max_tokens, force_refresh
        )
    
    async def is_api_available(self) -> bool:
        """Check if the VS Code extension API is available"""
        if not self.client:
            return False
            
        try:
            health = await self.client.health_check()
            return health.get("success", False)
        except Exception:
            return False 