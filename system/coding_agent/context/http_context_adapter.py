"""
HTTP Context Adapter for Code Generation Assistant

This module replaces the SQLite-based context retrieval with HTTP API calls
to the VS Code extension, maintaining backward compatibility with the existing
agent interface while using the new streaming API.
"""

import asyncio
import logging
from typing import Dict, Any, Optional, List
from datetime import datetime
import json

from .streaming_context_client import ContextManager, ContextData, StreamingContextClient


logger = logging.getLogger(__name__)


class HTTPContextAdapter:
    """
    HTTP-based context adapter that replaces SQLite ContextRetriever.
    
    This class maintains the same interface as the original ContextRetriever
    but fetches data from the VS Code extension's HTTP API instead of SQLite.
    """
    
    def __init__(self, base_url: str = "http://localhost:3001"):
        """
        Initialize the HTTP context adapter.
        
        Args:
            base_url: Base URL of the VS Code extension API server
        """
        self.base_url = base_url
        self.context_manager: Optional[ContextManager] = None
        self._current_workspace_id: Optional[str] = None
        self._last_context: Optional[ContextData] = None
        self._context_cache_ttl = 300  # 5 minutes cache
        self._last_fetch_time = 0
        
        logger.info(f"HTTPContextAdapter initialized with base URL: {base_url}")
    
    async def _ensure_context_manager(self) -> ContextManager:
        """Ensure context manager is initialized"""
        if self.context_manager is None:
            self.context_manager = ContextManager(self.base_url)
            await self.context_manager.__aenter__()
        return self.context_manager
    
    async def _cleanup_context_manager(self):
        """Cleanup context manager"""
        if self.context_manager:
            await self.context_manager.__aexit__(None, None, None)
            self.context_manager = None
    
    def connect(self) -> bool:
        """
        Connect to the HTTP API (compatibility method).
        
        Returns:
            True if API is available, False otherwise
        """
        try:
            # Run async check in sync context
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If we're already in an async context, create a task
                task = asyncio.create_task(self._check_connection())
                # This is a bit hacky, but maintains compatibility
                return True  # Assume connection for now
            else:
                return loop.run_until_complete(self._check_connection())
        except Exception as e:
            logger.error(f"Connection check failed: {e}")
            return False
    
    async def _check_connection(self) -> bool:
        """Async method to check API connection"""
        try:
            context_manager = await self._ensure_context_manager()
            return await context_manager.is_api_available()
        except Exception as e:
            logger.error(f"Failed to check API connection: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from the HTTP API (compatibility method)."""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(self._cleanup_context_manager())
            else:
                loop.run_until_complete(self._cleanup_context_manager())
            logger.info("Disconnected from HTTP API")
        except Exception as e:
            logger.warning(f"Error during disconnect: {e}")
    
    def get_workspace_info(self, workspace_id: str) -> Optional[Dict[str, Any]]:
        """
        Get workspace metadata by workspace ID (sync compatibility method).
        
        Args:
            workspace_id: The workspace identifier
            
        Returns:
            Workspace info dict or None if not found
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If we're in an async context, we need to schedule this differently
                # For now, return cached data if available
                if self._last_context and self._last_context.workspace:
                    return self._convert_workspace_info(workspace_id, self._last_context.workspace)
                return None
            else:
                return loop.run_until_complete(self._get_workspace_info_async(workspace_id))
        except Exception as e:
            logger.error(f"Error getting workspace info: {e}")
            return None
    
    async def _get_workspace_info_async(self, workspace_id: str) -> Optional[Dict[str, Any]]:
        """Async method to get workspace info"""
        try:
            context_data = await self._fetch_context_cached(workspace_id)
            if context_data and context_data.workspace:
                return self._convert_workspace_info(workspace_id, context_data.workspace)
            return None
        except Exception as e:
            logger.error(f"Error getting workspace info async: {e}")
            return None
    
    def _convert_workspace_info(self, workspace_id: str, workspace_data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert workspace data to expected format"""
        return {
            "id": workspace_id,
            "path": workspace_data.get("path", ""),
            "name": workspace_data.get("name", "Unknown"),
            "created_at": workspace_data.get("created_at", datetime.now().timestamp()),
            "updated_at": workspace_data.get("updated_at", datetime.now().timestamp())
        }
    
    def get_recent_context_session(self, workspace_id: str, max_tokens: int = 50000) -> Optional[Dict[str, Any]]:
        """
        Get the most recent context session for the workspace (sync compatibility method).
        
        Args:
            workspace_id: The workspace identifier
            max_tokens: Maximum token count for context
            
        Returns:
            Context session dict or None if not found
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Return cached data if available
                if (self._last_context and 
                    self._last_context.workspace_id == workspace_id and
                    self._last_context.total_tokens <= max_tokens):
                    return self._convert_context_session(self._last_context)
                return None
            else:
                return loop.run_until_complete(self._get_recent_context_session_async(workspace_id, max_tokens))
        except Exception as e:
            logger.error(f"Error getting recent context session: {e}")
            return None
    
    async def _get_recent_context_session_async(self, workspace_id: str, max_tokens: int = 50000) -> Optional[Dict[str, Any]]:
        """Async method to get recent context session"""
        try:
            context_data = await self._fetch_context_cached(workspace_id, max_tokens)
            if context_data:
                return self._convert_context_session(context_data)
            return None
        except Exception as e:
            logger.error(f"Error getting recent context session async: {e}")
            return None
    
    def _convert_context_session(self, context_data: ContextData) -> Dict[str, Any]:
        """Convert context data to session format"""
        # Convert ContextData to the format expected by the agent
        session_data = {
            "workspace": context_data.workspace,
            "activeFile": context_data.active_file,
            "openFiles": context_data.open_files,
            "projectStructure": context_data.project_structure,
            "gitContext": context_data.git_context,
            "totalTokens": context_data.total_tokens
        }
        
        return {
            "session_id": f"http_session_{context_data.workspace_id}_{int(datetime.now().timestamp())}",
            "context_data": session_data,
            "token_count": context_data.total_tokens,
            "created_at": context_data.timestamp or datetime.now().isoformat()
        }
    
    def get_file_stats(self, workspace_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Get file statistics for the workspace (sync compatibility method).
        
        Args:
            workspace_id: The workspace identifier
            limit: Maximum number of files to return
            
        Returns:
            List of file stat dictionaries
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Return cached data if available
                if self._last_context and self._last_context.open_files:
                    return self._convert_file_stats(self._last_context.open_files[:limit])
                return []
            else:
                return loop.run_until_complete(self._get_file_stats_async(workspace_id, limit))
        except Exception as e:
            logger.error(f"Error getting file stats: {e}")
            return []
    
    async def _get_file_stats_async(self, workspace_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Async method to get file stats"""
        try:
            context_data = await self._fetch_context_cached(workspace_id)
            if context_data and context_data.open_files:
                return self._convert_file_stats(context_data.open_files[:limit])
            return []
        except Exception as e:
            logger.error(f"Error getting file stats async: {e}")
            return []
    
    def _convert_file_stats(self, open_files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert open files data to file stats format"""
        file_stats = []
        for file_data in open_files:
            file_stats.append({
                "path": file_data.get("path", ""),
                "relative_path": file_data.get("relativePath", ""),
                "language_id": file_data.get("languageId", ""),
                "last_modified": file_data.get("lastModified", datetime.now().timestamp()),
                "file_size": file_data.get("fileSize", 0),
                "line_count": file_data.get("lineCount", 0),
                "access_frequency": file_data.get("accessFrequency", 1),
                "last_accessed": file_data.get("lastAccessed", datetime.now().timestamp())
            })
        return file_stats
    
    def get_workspace_context(self, workspace_id: str, max_tokens: int = 50000) -> Optional[Dict[str, Any]]:
        """
        Get comprehensive workspace context for the agent (sync compatibility method).
        
        Args:
            workspace_id: The workspace identifier
            max_tokens: Maximum token count for context
            
        Returns:
            Dict containing workspace context or None if not found
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Create a task to fetch context async
                task = asyncio.create_task(self._get_workspace_context_async(workspace_id, max_tokens))
                # Note: In a running loop, we can't wait synchronously
                # This is a limitation of the sync interface
                # For now, try to return cached data
                if (self._last_context and 
                    self._last_context.workspace_id == workspace_id and
                    self._last_context.total_tokens <= max_tokens):
                    return self._convert_workspace_context(self._last_context)
                logger.warning("Running in async context but no cached data available")
                return None
            else:
                return loop.run_until_complete(self._get_workspace_context_async(workspace_id, max_tokens))
        except Exception as e:
            logger.error(f"Error getting workspace context: {e}")
            return None
    
    async def _get_workspace_context_async(self, workspace_id: str, max_tokens: int = 50000) -> Optional[Dict[str, Any]]:
        """Async method to get workspace context"""
        try:
            context_data = await self._fetch_context_cached(workspace_id, max_tokens)
            if context_data:
                return self._convert_workspace_context(context_data)
            return None
        except Exception as e:
            logger.error(f"Error getting workspace context async: {e}")
            return None
    
    def _convert_workspace_context(self, context_data: ContextData) -> Dict[str, Any]:
        """Convert ContextData to the format expected by the agent"""
        workspace_info = {
            "id": context_data.workspace_id,
            "path": context_data.workspace.get("path", "") if context_data.workspace else "",
            "name": context_data.workspace.get("name", "Unknown") if context_data.workspace else "Unknown",
            "created_at": datetime.now().timestamp(),
            "updated_at": datetime.now().timestamp()
        }
        
        # Convert context data to expected format
        converted_context = {
            "workspace": context_data.workspace,
            "activeFile": context_data.active_file,
            "openFiles": context_data.open_files,
            "projectStructure": context_data.project_structure,
            "gitContext": context_data.git_context,
            "totalTokens": context_data.total_tokens
        }
        
        return {
            "workspace_info": workspace_info,
            "context_data": converted_context,
            "source": "http_streaming_api",
            "token_count": context_data.total_tokens,
            "session_id": f"http_session_{context_data.workspace_id}"
        }
    
    async def _fetch_context_cached(self, workspace_id: str, max_tokens: int = 50000) -> Optional[ContextData]:
        """Fetch context with caching"""
        current_time = datetime.now().timestamp()
        
        # Return cached context if still valid
        if (self._last_context and 
            self._last_context.workspace_id == workspace_id and
            current_time - self._last_fetch_time < self._context_cache_ttl and
            self._last_context.total_tokens <= max_tokens):
            logger.debug(f"Returning cached context for workspace: {workspace_id}")
            return self._last_context
        
        # Fetch fresh context
        try:
            context_manager = await self._ensure_context_manager()
            context_data = await context_manager.get_context(workspace_id, max_tokens)
            
            # Update cache
            self._last_context = context_data
            self._last_fetch_time = current_time
            self._current_workspace_id = workspace_id
            
            logger.info(f"Fetched fresh context for workspace: {workspace_id} ({context_data.total_tokens} tokens)")
            return context_data
            
        except Exception as e:
            logger.error(f"Failed to fetch context for workspace {workspace_id}: {e}")
            return None
    
    def get_context_summary(self, workspace_id: str) -> str:
        """
        Get a human-readable summary of available context (sync compatibility method).
        
        Args:
            workspace_id: The workspace identifier
            
        Returns:
            Human-readable context summary
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Use cached data if available
                if self._last_context and self._last_context.workspace_id == workspace_id:
                    return self._create_context_summary(workspace_id, self._last_context)
                return f"❌ No cached context available for workspace: {workspace_id}"
            else:
                return loop.run_until_complete(self._get_context_summary_async(workspace_id))
        except Exception as e:
            return f"❌ Error getting context summary: {e}"
    
    async def _get_context_summary_async(self, workspace_id: str) -> str:
        """Async method to get context summary"""
        try:
            # Check if API is available
            context_manager = await self._ensure_context_manager()
            if not await context_manager.is_api_available():
                return f"❌ VS Code extension API not available at {self.base_url}"
            
            # Fetch context
            context_data = await self._fetch_context_cached(workspace_id)
            if not context_data:
                return f"❌ No context available for workspace: {workspace_id}"
            
            return self._create_context_summary(workspace_id, context_data)
            
        except Exception as e:
            return f"❌ Error getting context summary: {e}"
    
    def _create_context_summary(self, workspace_id: str, context_data: ContextData) -> str:
        """Create a human-readable context summary"""
        workspace_name = "Unknown"
        workspace_path = ""
        
        if context_data.workspace:
            workspace_name = context_data.workspace.get("name", "Unknown")
            workspace_path = context_data.workspace.get("path", "")
        
        file_count = len(context_data.open_files) if context_data.open_files else 0
        languages = set()
        if context_data.open_files:
            for file_data in context_data.open_files:
                lang = file_data.get("languageId")
                if lang:
                    languages.add(lang)
        
        active_file_info = ""
        if context_data.active_file:
            active_file_info = f"\n  📄 Active file: {context_data.active_file.get('relativePath', 'Unknown')}"
        
        git_info = ""
        if context_data.git_context:
            repo_info = context_data.git_context.get("repository", {})
            if repo_info.get("isRepo"):
                branch = repo_info.get("currentBranch", "unknown")
                git_info = f"\n  🔀 Git branch: {branch}"
        
        summary = f"""
📁 Workspace Context Summary (HTTP API):
  🏠 Workspace: {workspace_name} ({workspace_path})
  🆔 ID: {workspace_id}
  📊 Total tokens: {context_data.total_tokens}
  📂 Open files: {file_count}
  🗂️ Languages: {', '.join(sorted(languages)) if languages else 'None'}{active_file_info}{git_info}
  🌐 Source: VS Code Extension API ({self.base_url})
  🕐 Fetched: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
"""
        return summary.strip()
    
    async def force_refresh_context(self, workspace_id: str) -> bool:
        """
        Force refresh of context data from the extension.
        
        Args:
            workspace_id: The workspace identifier
            
        Returns:
            True if refresh was successful
        """
        try:
            context_manager = await self._ensure_context_manager()
            
            # Force collection on the extension side
            if hasattr(context_manager, 'client') and context_manager.client:
                await context_manager.client.force_context_collection(workspace_id)
            
            # Clear cache to force fresh fetch
            self._last_context = None
            self._last_fetch_time = 0
            
            # Fetch fresh context
            context_data = await self._fetch_context_cached(workspace_id)
            return context_data is not None
            
        except Exception as e:
            logger.error(f"Failed to force refresh context: {e}")
            return False


# Backward compatibility alias
ContextRetriever = HTTPContextAdapter 