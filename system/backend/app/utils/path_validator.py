import os
from typing import Tuple

# Define system directories that are off-limits
SYSTEM_DIRECTORIES = [
    os.path.abspath("system"),
    os.path.abspath("system/backend"),
    os.path.abspath("system/coding_agent"),
    os.path.abspath("system/mcp_server"),
]

# Define any additional paths that should be protected
PROTECTED_ROOT_PATHS = [
    "/bin", 
    "/sbin", 
    "/usr", 
    "/etc", 
    "/var", 
    "/System", 
    "/Library",
    # Add any other system paths that should be protected
]

def is_safe_path(path: str) -> Tuple[bool, str]:
    """
    Check if a path is safe to access (not in system directories or protected paths).
    
    Args:
        path: The path to check
        
    Returns:
        Tuple containing:
            - Boolean indicating if the path is safe
            - Error message if path is not safe, None otherwise
    """
    # Convert to absolute path for reliable checking
    abs_path = os.path.abspath(path)
    
    # Check if path is in a system directory
    for system_dir in SYSTEM_DIRECTORIES:
        if abs_path.startswith(system_dir):
            return False, f"Path '{path}' is in a protected system directory"
            
    # Check if path is in a protected root path
    for protected_path in PROTECTED_ROOT_PATHS:
        if abs_path.startswith(protected_path):
            return False, f"Path '{path}' is in a protected system path"
    
    # Add additional checks as needed
    
    # Path is considered safe if no checks failed
    return True, "" 