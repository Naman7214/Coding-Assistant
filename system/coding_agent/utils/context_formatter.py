def format_system_info_context(system_info) -> str:
    """Format system information concisely"""
    if not system_info:
        return ""
    
    return f"OS: {system_info.get('platform', 'unknown')} {system_info.get('osVersion', '')}, Shell: {system_info.get('defaultShell', '/bin/bash')}"


def format_active_file_context(active_file_context) -> str:
    """Format active file context concisely"""
    if not active_file_context:
        return ""
    
    try:
        file = active_file_context.get('file', {})
        cursor = active_file_context.get('cursor', {})
        
        # Extract file info
        rel_path = file.get('path', '').replace(active_file_context.get('workspace_path', ''), '').lstrip('/')
        lang = file.get('languageId', '')
        lines = file.get('lineCount', 0)
        
        # Extract cursor info
        cursor_line = cursor.get('line', 0) + 1  # Convert to 1-based
        cursor_char = cursor.get('character', 0)
        
        # Extract line content
        line_content = cursor.get('lineContent', {})
        current_line = line_content.get('current', '').strip()
        
        # Build concise context
        context = f"📁 {rel_path} ({lang}, {lines}L)"
        context += f" | 📍 {cursor_line}:{cursor_char}"
        
        if current_line:
            context += f" | Current: `{current_line[:50]}{'...' if len(current_line) > 50 else ''}`"
        
        # Add selection if exists
        selection = cursor.get('selection', [])
        if len(selection) >= 2:
            start = selection[0]
            end = selection[1] 
            if start.get('line') != end.get('line') or start.get('character') != end.get('character'):
                context += f" | Selected: {start.get('line', 0)+1}:{start.get('character', 0)}-{end.get('line', 0)+1}:{end.get('character', 0)}"
        
        return context
        
    except Exception as e:
        return f"Active file: {str(active_file_context)[:100]}..."


def format_open_files_context(open_files_context) -> str:
    """Format open files context concisely"""
    if not open_files_context:
        return ""
    
    try:
        count = len(open_files_context)
        if count == 0:
            return ""
        
        # Show first few files
        files_str = ""
        for i, file_info in enumerate(open_files_context[:3]):
            path = file_info.get('path', '')
            # Extract just filename or relative path
            name = path.split('/')[-1] if '/' in path else path
            lang = file_info.get('languageId', '')
            if i > 0:
                files_str += ", "
            files_str += f"{name}({lang})"
        
        if count > 3:
            files_str += f", +{count-3} more"
        
        return f"📂 Open: {files_str}"
        
    except Exception:
        return f"📂 {len(open_files_context)} files open"


def format_recent_edits_context(recent_edits_context) -> str:
    """Format recent edits context concisely"""
    if not recent_edits_context:
        return ""
    
    try:
        # Handle both Pydantic model and dict for backward compatibility
        if hasattr(recent_edits_context, 'summary'):
            # Pydantic model
            summary = recent_edits_context.summary
            has_changes = summary.hasChanges
            total_files = summary.totalFiles
            modified = recent_edits_context.modifiedFiles
            added = recent_edits_context.addedFiles
            deleted = recent_edits_context.deletedFiles
        else:
            # Dictionary (backward compatibility)
            summary = recent_edits_context.get('summary', {})
            has_changes = summary.get('hasChanges', False)
            total_files = summary.get('totalFiles', 0)
            modified = recent_edits_context.get('modifiedFiles', [])
            added = recent_edits_context.get('addedFiles', [])
            deleted = recent_edits_context.get('deletedFiles', [])
        
        if not has_changes:
            return ""
        
        context = f"📝 Recent: {total_files} file{'s' if total_files != 1 else ''} changed"
        
        # Add file names if available
        files = []
        for f in modified[:2]:
            if hasattr(f, 'relativePath'):
                rel_path = f.relativePath
            else:
                rel_path = f.get('relativePath', '')
            files.append(f"~{rel_path}")
        for f in added[:2]:
            if hasattr(f, 'relativePath'):
                rel_path = f.relativePath
            else:
                rel_path = f.get('relativePath', '')
            files.append(f"+{rel_path}")
        for f in deleted[:2]:
            if hasattr(f, 'relativePath'):
                rel_path = f.relativePath
            else:
                rel_path = f.get('relativePath', '')
            files.append(f"-{rel_path}")
        
        if files:
            context += f" ({', '.join(files)})"
            
        return context
        
    except Exception:
        return "📝 Recent changes detected"


def format_additional_context(additional_context) -> str:
    """Format additional context concisely"""
    if not additional_context:
        return ""
    
    # This can be extended for future context types
    return ""


def format_workspace_context(workspace_path: str, git_branch: str) -> str:
    """Format workspace context concisely"""
    if not workspace_path:
        return ""
    
    workspace_name = workspace_path.split('/')[-1] if '/' in workspace_path else workspace_path
    branch_info = f" (git: {git_branch})" if git_branch and git_branch != "default" else ""
    
    return f"🚀 Workspace: {workspace_name}{branch_info}"


def create_concise_context_prompt(
    system_info=None,
    active_file_context=None, 
    open_files_context=None,
    recent_edits_context=None,
    workspace_path=None,
    git_branch=None
) -> str:
    """Create a single concise context line for the system prompt"""
    
    context_parts = []
    
    # Add workspace info
    workspace_ctx = format_workspace_context(workspace_path, git_branch)
    if workspace_ctx:
        context_parts.append(workspace_ctx)
    
    # Add system info
    system_ctx = format_system_info_context(system_info)
    if system_ctx:
        context_parts.append(system_ctx)
    
    # Add active file
    active_ctx = format_active_file_context(active_file_context)
    if active_ctx:
        context_parts.append(active_ctx)
    
    # Add open files
    open_ctx = format_open_files_context(open_files_context)
    if open_ctx:
        context_parts.append(open_ctx)
    
    # Add recent edits
    edits_ctx = format_recent_edits_context(recent_edits_context)
    if edits_ctx:
        context_parts.append(edits_ctx)
    
    if context_parts:
        return f"\n<CONTEXT>\n{' | '.join(context_parts)}\n</CONTEXT>\n"
    
    return ""
