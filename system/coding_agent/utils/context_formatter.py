def format_system_info_context(system_info) -> str:
    """Format system information concisely"""
    if not system_info:
        return ""
    system_info_message = f"""
        <SYSTEM_INFO>
        You are working on a **{system_info.get('platform', 'unknown')}** system.
        - OS Version     : {system_info.get('osVersion', 'unknown')}
        - Architecture   : {system_info.get('architecture', 'unknown')}
        - Shell          : {system_info.get('defaultShell', '/bin/bash')}
        - Workspace Path : {system_info.get('workspacePath', 'not specified')}
        </SYSTEM_INFO>
        Please proceed accordingly based on this environment setup.
        """

    return system_info_message


def truncate_to_words(text: str, max_words: int = 3000) -> str:
    """Truncate text to maximum number of words"""
    if not text:
        return text

    words = text.split()
    if len(words) <= max_words:
        return text

    truncated = " ".join(words[:max_words])
    return f"{truncated}\n\n[... content truncated to {max_words} words ...]"


def format_active_file_context(active_file_context) -> str:
    """Format active file context concisely"""
    if not active_file_context:
        return ""

    try:
        # Truncate the active file context to 3000 words
        truncated_context = truncate_to_words(str(active_file_context))

        context = f"""
        The Below context is about the active file user is working in with the position of the cursor and the selection of the cursor.
        <ACTIVE_FILE_CONTEXT>
        {truncated_context}
        </ACTIVE_FILE_CONTEXT>
        """

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

        # Truncate the open files context to 3000 words
        truncated_context = truncate_to_words(str(open_files_context))

        context = f"""
        The Below are the list of files that are open in the editor.
        <OPEN_FILES_CONTEXT>
        {truncated_context}
        </OPEN_FILES_CONTEXT>
        """
        return context

    except Exception:
        return f"📂 {len(open_files_context)} files open"


def format_recent_edits_context(recent_edits_context) -> str:
    """Format recent edits context concisely"""
    if not recent_edits_context:
        return ""

    try:
        # Truncate the recent edits context to 3000 words
        truncated_context = truncate_to_words(str(recent_edits_context))

        context = f"""
        The Below context is about the recent edits that user has made in the editor including the files which are added and deleted in last few minutes.
        <RECENT_EDITS_CONTEXT>
        {truncated_context}
        </RECENT_EDITS_CONTEXT>
        """

        return context

    except Exception:
        return "📝 Recent changes detected"


def format_context_mentions(context_mentions) -> str:
    """Format additional context concisely"""
    if not context_mentions:
        return ""

    # Truncate the context mentions to 3000 words
    truncated_context = truncate_to_words(str(context_mentions))

    context = f"""
    The Below context is about the context mentions that user has mentioned in the conversation.
    <CONTEXT_MENTIONS>
    {truncated_context}
    </CONTEXT_MENTIONS>
    """

    return context


def format_user_query(
    user_query,
    active_file_context,
    open_files_context,
    recent_edits_context,
    context_mentions,
) -> str:
    """Format user query concisely"""
    if not user_query:
        return ""

    context = f"""
    The user Query is:
    <USER_QUERY>
    {user_query}
    </USER_QUERY>
    
    Below are the very useful but confidential context that you should use to take the best decision but never mention or disclose it while communicating with the user.
    """

    if active_file_context:
        context += format_active_file_context(active_file_context)

    if open_files_context:
        context += format_open_files_context(open_files_context)

    if recent_edits_context:
        context += format_recent_edits_context(recent_edits_context)

    if context_mentions:
        context += format_context_mentions(context_mentions)

    return context


def get_friendly_tool_name(tool_name: str) -> str:
    """Convert technical tool names to user-friendly descriptions"""
    friendly_names = {
        "grep_search": "Grepping the Codebase",
        "read_file": "Reading File",
        "run_terminal_command": "Running Terminal Command",
        "delete_file": "Deleting File",
        "list_directory": "Listing Directories",
        "search_and_replace": "Searching and Replacing in Files",
        "search_files": "Searching Files",
        "web_search": "Searching the Web",
        "codebase_search": "Searching the Codebase Semantically",
        "edit_file": "Editing File",
        "reapply": "Reapplying Smarter Changes",
        "get_project_structure": "Getting Project Structure",
        "get_git_context": "Fetching Git Context",
    }
    return friendly_names.get(tool_name, tool_name)
