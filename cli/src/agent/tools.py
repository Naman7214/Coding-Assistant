"""
Tools for the Code Generation Assistant.
These tools implement the core functionality that the agent can use.
"""
import os
import re
import subprocess
from typing import List, Optional, Dict, Any

class Tool:
    """Base class for all tools"""
    name: str
    description: str
    
    def execute(self, **kwargs) -> Dict[str, Any]:
        """Execute the tool with the given parameters"""
        raise NotImplementedError("Tool must implement execute method")

class CodebaseSearchTool(Tool):
    """Perform semantic code search to find relevant logic or definitions."""
    name = "codebase_search"
    description = "Perform semantic code search to find relevant logic or definitions."
    
    def execute(self, query: str, target_directories: Optional[List[str]] = None) -> Dict[str, Any]:
        # Mock implementation - in a real system, this would use embeddings or an API
        results = {"matches": [], "query": query}
        target_dirs = target_directories or ["."]
        
        # Simple keyword-based search as a placeholder
        for directory in target_dirs:
            for root, _, files in os.walk(directory):
                for file in files:
                    if file.endswith(('.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css')):
                        try:
                            filepath = os.path.join(root, file)
                            with open(filepath, 'r', encoding='utf-8') as f:
                                content = f.read()
                                if query.lower() in content.lower():
                                    results["matches"].append({
                                        "file": filepath,
                                        "content": content[:200] + "..." if len(content) > 200 else content
                                    })
                        except Exception as e:
                            print(f"Error reading {file}: {e}")
        
        return results

class ReadFileTool(Tool):
    """Access and display the contents of a given file."""
    name = "read_file"
    description = "Access and display the contents of a given file."
    
    def execute(self, target_file: str, offset: int = 0, limit: Optional[int] = None) -> Dict[str, Any]:
        try:
            with open(target_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                
            if limit is None:
                content = ''.join(lines[offset:])
            else:
                content = ''.join(lines[offset:offset+limit])
            
            return {
                "file": target_file,
                "content": content,
                "total_lines": len(lines),
                "read_lines": len(lines[offset:]) if limit is None else min(limit, len(lines[offset:]))
            }
        except Exception as e:
            return {"error": str(e)}

class RunTerminalCmdTool(Tool):
    """Execute shell commands within the project environment."""
    name = "run_terminal_cmd"
    description = "Execute shell commands within the project environment."
    
    def execute(self, command: str) -> Dict[str, Any]:
        try:
            result = subprocess.run(
                command, 
                shell=True, 
                capture_output=True, 
                text=True
            )
            return {
                "command": command,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "return_code": result.returncode
            }
        except Exception as e:
            return {"error": str(e)}

class ListDirTool(Tool):
    """List files and subdirectories within a specified path."""
    name = "list_dir"
    description = "List files and subdirectories within a specified path."
    
    def execute(self, path: str = ".") -> Dict[str, Any]:
        try:
            items = os.listdir(path)
            files = []
            directories = []
            
            for item in items:
                item_path = os.path.join(path, item)
                if os.path.isdir(item_path):
                    directories.append(item)
                else:
                    files.append(item)
            
            return {
                "path": os.path.abspath(path),
                "files": files,
                "directories": directories
            }
        except Exception as e:
            return {"error": str(e)}

class GrepSearchTool(Tool):
    """Search for regex patterns across files to locate relevant code."""
    name = "grep_search"
    description = "Search for regex patterns across files to locate relevant code."
    
    def execute(self, 
               query: str, 
               include_pattern: Optional[str] = None,
               exclude_pattern: Optional[str] = None,
               case_sensitive: bool = False) -> Dict[str, Any]:
        results = []
        flags = 0 if case_sensitive else re.IGNORECASE
        pattern = re.compile(query, flags)
        
        for root, _, files in os.walk('.'):
            for file in files:
                # Skip files based on exclude_pattern
                if exclude_pattern and re.search(exclude_pattern, file):
                    continue
                
                # Include only files matching include_pattern
                if include_pattern and not re.search(include_pattern, file):
                    continue
                
                try:
                    filepath = os.path.join(root, file)
                    with open(filepath, 'r', encoding='utf-8') as f:
                        for i, line in enumerate(f, 1):
                            if pattern.search(line):
                                results.append({
                                    "file": filepath,
                                    "line_number": i,
                                    "line": line.strip()
                                })
                except Exception:
                    # Skip files that can't be read
                    pass
        
        return {
            "query": query,
            "matches": results[:50],  # Limit to 50 matches to avoid overwhelming output
            "total_matches": len(results)
        }

class EditFileTool(Tool):
    """Programmatically create or modify code in files."""
    name = "edit_file"
    description = "Programmatically create or modify code in files."
    
    def execute(self, 
               target_file: str, 
               content: str,
               mode: str = "write") -> Dict[str, Any]:
        try:
            os.makedirs(os.path.dirname(target_file), exist_ok=True)
            
            if mode == "write":
                # Overwrite the file
                with open(target_file, 'w', encoding='utf-8') as f:
                    f.write(content)
            elif mode == "append":
                # Append to the file
                with open(target_file, 'a', encoding='utf-8') as f:
                    f.write(content)
            elif mode == "insert":
                # Read the file, edit it, and write it back
                with open(target_file, 'r', encoding='utf-8') as f:
                    old_content = f.read()
                with open(target_file, 'w', encoding='utf-8') as f:
                    f.write(old_content + content)
            else:
                return {"error": f"Unknown mode: {mode}"}
            
            return {
                "file": target_file,
                "mode": mode,
                "success": True
            }
        except Exception as e:
            return {"error": str(e)}

class SearchReplaceTool(Tool):
    """Perform search-and-replace operations within files."""
    name = "search_replace"
    description = "Perform search-and-replace operations within files."
    
    def execute(self, 
               target_file: str, 
               search_pattern: str,
               replacement: str,
               regex: bool = False) -> Dict[str, Any]:
        try:
            with open(target_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            if regex:
                new_content, count = re.subn(search_pattern, replacement, content)
            else:
                new_content = content.replace(search_pattern, replacement)
                count = content.count(search_pattern)
            
            with open(target_file, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            return {
                "file": target_file,
                "replacements": count,
                "success": True
            }
        except Exception as e:
            return {"error": str(e)}

class FileSearchTool(Tool):
    """Fuzzy search to identify files based on partial matches."""
    name = "file_search"
    description = "Fuzzy search to identify files based on partial matches."
    
    def execute(self, query: str) -> Dict[str, Any]:
        results = []
        
        for root, dirs, files in os.walk('.'):
            for item in files + dirs:
                if query.lower() in item.lower():
                    path = os.path.join(root, item)
                    results.append({
                        "path": path,
                        "is_dir": os.path.isdir(path)
                    })
        
        # Sort by relevance (exact match first, then by path length)
        results.sort(key=lambda x: (0 if x["path"].lower().endswith(query.lower()) else 1, len(x["path"])))
        
        return {
            "query": query,
            "matches": results[:10]  # Limit to 10 matches
        }

class DeleteFileTool(Tool):
    """Remove files from the codebase."""
    name = "delete_file"
    description = "Remove files from the codebase."
    
    def execute(self, target_file: str) -> Dict[str, Any]:
        try:
            if os.path.exists(target_file):
                if os.path.isdir(target_file):
                    os.rmdir(target_file)  # Will only work if directory is empty
                else:
                    os.remove(target_file)
                return {
                    "file": target_file,
                    "success": True
                }
            else:
                return {
                    "file": target_file,
                    "success": False,
                    "error": "File not found"
                }
        except Exception as e:
            return {"error": str(e)}

class WebSearchTool(Tool):
    """Fetch external information from the web."""
    name = "web_search"
    description = "Fetch external information from the web to inform code generation or decisions."
    
    def execute(self, search_term: str) -> Dict[str, Any]:
        # Mock implementation - in a real system, this would use a search API
        return {
            "query": search_term,
            "results": [
                {
                    "title": f"Mock result for {search_term}",
                    "url": f"https://example.com/search?q={search_term}",
                    "snippet": f"This is a mock result for the search term '{search_term}'."
                }
            ]
        }

# Dictionary of available tools
AVAILABLE_TOOLS = {
    "codebase_search": CodebaseSearchTool(),
    "read_file": ReadFileTool(),
    "run_terminal_cmd": RunTerminalCmdTool(),
    "list_dir": ListDirTool(),
    "grep_search": GrepSearchTool(),
    "edit_file": EditFileTool(),
    "search_replace": SearchReplaceTool(),
    "file_search": FileSearchTool(),
    "delete_file": DeleteFileTool(),
    "web_search": WebSearchTool(),
} 