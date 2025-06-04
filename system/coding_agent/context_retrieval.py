import json
import sqlite3
import os
from typing import Dict, Any, Optional, List
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class ContextRetriever:
    """
    Retrieves workspace context from the SQLite database created by the VS Code extension.
    This allows the agent to access context without needing it passed in the request.
    """
    
    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the context retriever.
        
        Args:
            db_path: Path to SQLite database. If None, uses default location.
        """
        if db_path:
            self.db_path = db_path
        else:
            # Use the same default path as the extension
            home_dir = os.path.expanduser("~")
            config_dir = os.path.join(home_dir, ".codegen-assistant")
            self.db_path = os.path.join(config_dir, "context.db")
        
        self.connection = None
        logger.info(f"ContextRetriever initialized with database: {self.db_path}")
    
    def connect(self) -> bool:
        """Connect to the SQLite database."""
        try:
            if not os.path.exists(self.db_path):
                logger.warning(f"Context database not found at: {self.db_path}")
                return False
            
            self.connection = sqlite3.connect(self.db_path, timeout=30.0)
            self.connection.row_factory = sqlite3.Row  # Enable column access by name
            logger.info("Successfully connected to context database")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to context database: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from the SQLite database."""
        if self.connection:
            self.connection.close()
            self.connection = None
            logger.info("Disconnected from context database")
    
    def get_workspace_info(self, workspace_id: str) -> Optional[Dict[str, Any]]:
        """Get workspace metadata by workspace ID."""
        if not self.connection:
            return None
        
        try:
            cursor = self.connection.cursor()
            cursor.execute("""
                SELECT workspace_path, workspace_name, created_at, updated_at
                FROM workspace_sessions 
                WHERE id = ? AND is_active = 1
            """, (workspace_id,))
            
            row = cursor.fetchone()
            if not row:
                logger.warning(f"Workspace not found: {workspace_id}")
                return None
            
            return {
                "id": workspace_id,
                "path": row["workspace_path"],
                "name": row["workspace_name"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"]
            }
        except Exception as e:
            logger.error(f"Error getting workspace info: {e}")
            return None
    
    def get_recent_context_session(self, workspace_id: str, max_tokens: int = 50000) -> Optional[Dict[str, Any]]:
        """Get the most recent context session for the workspace."""
        if not self.connection:
            return None
        
        try:
            cursor = self.connection.cursor()
            
            # Get the most recent context session
            cursor.execute("""
                SELECT id, context_version, token_count, created_at, updated_at
                FROM context_sessions 
                WHERE workspace_id = ? AND token_count <= ?
                ORDER BY updated_at DESC 
                LIMIT 1
            """, (workspace_id, max_tokens))
            
            session_row = cursor.fetchone()
            if not session_row:
                logger.info(f"No recent context session found for workspace: {workspace_id}")
                return None
            
            session_id = session_row["id"]
            
            # Get the context data from cache
            cursor.execute("""
                SELECT data_content, token_count, created_at
                FROM context_cache 
                WHERE workspace_id = ? AND cache_key = ? AND expires_at > ?
            """, (workspace_id, f"context_session_{session_id}", int(datetime.now().timestamp())))
            
            cache_row = cursor.fetchone()
            if not cache_row:
                logger.info(f"Context session data not found in cache: {session_id}")
                return None
            
            # Parse the cached context data
            context_data = json.loads(cache_row["data_content"])
            
            return {
                "session_id": session_id,
                "context_data": context_data,
                "token_count": cache_row["token_count"],
                "created_at": cache_row["created_at"]
            }
            
        except Exception as e:
            logger.error(f"Error getting recent context session: {e}")
            return None
    
    def get_file_stats(self, workspace_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Get file statistics for the workspace."""
        if not self.connection:
            return []
        
        try:
            cursor = self.connection.cursor()
            cursor.execute("""
                SELECT path, relative_path, language_id, last_modified, file_size, 
                       line_count, access_frequency, last_accessed
                FROM files 
                WHERE workspace_id = ? AND is_deleted = 0
                ORDER BY access_frequency DESC, last_accessed DESC
                LIMIT ?
            """, (workspace_id, limit))
            
            files = []
            for row in cursor.fetchall():
                files.append({
                    "path": row["path"],
                    "relative_path": row["relative_path"],
                    "language_id": row["language_id"],
                    "last_modified": row["last_modified"],
                    "file_size": row["file_size"],
                    "line_count": row["line_count"],
                    "access_frequency": row["access_frequency"],
                    "last_accessed": row["last_accessed"]
                })
            
            return files
        except Exception as e:
            logger.error(f"Error getting file stats: {e}")
            return []
    
    def get_workspace_context(self, workspace_id: str, max_tokens: int = 50000) -> Optional[Dict[str, Any]]:
        """
        Get comprehensive workspace context for the agent.
        
        Args:
            workspace_id: The workspace identifier
            max_tokens: Maximum token count for context
            
        Returns:
            Dict containing workspace context or None if not found
        """
        if not self.connect():
            return None
        
        try:
            # Get workspace info
            workspace_info = self.get_workspace_info(workspace_id)
            if not workspace_info:
                return None
            
            # Try to get recent context session first
            recent_context = self.get_recent_context_session(workspace_id, max_tokens)
            if recent_context:
                logger.info(f"Retrieved recent context session: {recent_context['session_id']}")
                return {
                    "workspace_info": workspace_info,
                    "context_data": recent_context["context_data"],
                    "source": "cached_session",
                    "token_count": recent_context["token_count"],
                    "session_id": recent_context["session_id"]
                }
            
            # If no recent session, build basic context from available data
            logger.info("No recent context session found, building basic context from database")
            file_stats = self.get_file_stats(workspace_id, 100)
            
            # Build a simplified context structure
            basic_context = {
                "workspace": {
                    "path": workspace_info["path"],
                    "name": workspace_info["name"],
                    "id": workspace_id
                },
                "files": file_stats,
                "summary": {
                    "total_files": len(file_stats),
                    "languages": list(set(f["language_id"] for f in file_stats if f["language_id"])),
                    "most_accessed_files": file_stats[:10] if file_stats else []
                }
            }
            
            return {
                "workspace_info": workspace_info,
                "context_data": basic_context,
                "source": "database_files",
                "token_count": self._estimate_token_count(basic_context),
                "session_id": None
            }
            
        finally:
            self.disconnect()
    
    def _estimate_token_count(self, context_data: Dict[str, Any]) -> int:
        """Estimate token count for context data."""
        try:
            # Rough estimation: 4 characters per token
            context_str = json.dumps(context_data)
            return len(context_str) // 4
        except:
            return 0
    
    def get_context_summary(self, workspace_id: str) -> str:
        """Get a human-readable summary of available context."""
        if not self.connect():
            return "❌ Cannot connect to context database"
        
        try:
            workspace_info = self.get_workspace_info(workspace_id)
            if not workspace_info:
                return f"❌ Workspace not found: {workspace_id}"
            
            if not self.connection:
                return "❌ Database connection lost"
            
            # Get session count
            cursor = self.connection.cursor()
            cursor.execute("SELECT COUNT(*) as count FROM context_sessions WHERE workspace_id = ?", (workspace_id,))
            session_count = cursor.fetchone()["count"]
            
            # Get file count
            cursor.execute("SELECT COUNT(*) as count FROM files WHERE workspace_id = ? AND is_deleted = 0", (workspace_id,))
            file_count = cursor.fetchone()["count"]
            
            # Get recent session info
            recent_context = self.get_recent_context_session(workspace_id)
            recent_session_info = ""
            if recent_context:
                recent_session_info = f"\n  📄 Recent session: {recent_context['session_id']} ({recent_context['token_count']} tokens)"
            
            summary = f"""
📁 Workspace Context P
  🏠 Workspace: {workspace_info['name']} ({workspace_info['path']})
  🆔 ID: {workspace_id}
  📊 Context sessions: {session_count}
  📂 Tracked files: {file_count}{recent_session_info}
  🕐 Last updated: {datetime.fromtimestamp(workspace_info['updated_at']).strftime('%Y-%m-%d %H:%M:%S')}
"""
            return summary.strip()
            
        except Exception as e:
            return f"❌ Error getting context summary: {e}"
        finally:
            self.disconnect() 