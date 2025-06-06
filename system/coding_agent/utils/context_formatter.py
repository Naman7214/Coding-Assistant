def format_system_info_context(system_info) -> str:
    """Format system information for the prompt"""
    if not system_info:
        return "No system information available."

    try:

        context = f"""
                SYSTEM INFORMATION:
                - Platform: {system_info.get('platform', 'unknown')}
                - OS Version: {system_info.get('osVersion', 'unknown')}
                - Architecture: {system_info.get('architecture', 'unknown')}
                - Workspace Path: {system_info.get('workspacePath', 'unknown')}
                - Default Shell: {system_info.get('defaultShell', 'unknown')}
                """
    except Exception as e:
        context = str(system_info)
    return context


def format_active_file_context(active_file_context) -> str:
    """Format active file context for inclusion in system prompt"""
    if not active_file_context:
        return ""

    try:
        context = f"""
=== ACTIVE FILE CONTEXT ===
Currently editing: {active_file_context.get('relativePath', 'Unknown')}
Language: {active_file_context.get('languageId', 'unknown')}
Lines: {active_file_context.get('lineCount', 0)}"""

        # Add absolute path if available
        if active_file_context.get("path"):
            context += f"\nAbsolute Path: {active_file_context['path']}"

        # Add file size and last modified if available
        if active_file_context.get("fileSize"):
            file_size = active_file_context["fileSize"]
            if file_size > 1024 * 1024:
                context += f"\nFile Size: {file_size / (1024 * 1024):.1f} MB"
            elif file_size > 1024:
                context += f"\nFile Size: {file_size / 1024:.1f} KB"
            else:
                context += f"\nFile Size: {file_size} bytes"

        if active_file_context.get("lastModified"):
            context += f"\nLast Modified: {active_file_context['lastModified']}"

        # Add cursor position if available
        if active_file_context.get("cursorPosition"):
            cursor_pos = active_file_context["cursorPosition"]
            context += f"\nCursor Position: Line {cursor_pos.get('line', 0)}, Character {cursor_pos.get('character', 0)}"

        # Add cursor line content if available (very useful for context)
        if active_file_context.get("cursorLineContent"):
            cursor_content = active_file_context["cursorLineContent"]
            context += f"\nCursor Context:"
            if cursor_content.get("above"):
                context += f"\n  Line Above: '{cursor_content['above']}'"
            if cursor_content.get("current"):
                context += f"\n  Current Line: '{cursor_content['current']}'"
            if cursor_content.get("below"):
                context += f"\n  Line Below: '{cursor_content['below']}'"

        # Add selection if available (fix: check for start/end, not isEmpty)
        if active_file_context.get("selection"):
            selection = active_file_context["selection"]
            start = selection.get("start", {})
            end = selection.get("end", {})

            # Check if there's actually a selection (start != end)
            start_line = start.get("line", 0)
            start_char = start.get("character", 0)
            end_line = end.get("line", 0)
            end_char = end.get("character", 0)

            if start_line != end_line or start_char != end_char:
                if start_line == end_line:
                    context += f"\nSelection: Line {start_line}, Characters {start_char}-{end_char}"
                else:
                    context += f"\nSelection: Lines {start_line}-{end_line} (from {start_line}:{start_char} to {end_line}:{end_char})"

        # Add visible ranges if available
        if active_file_context.get("visibleRanges"):
            visible_ranges = active_file_context["visibleRanges"]
            if (
                visible_ranges
                and isinstance(visible_ranges, list)
                and len(visible_ranges) > 0
            ):
                context += f"\nVisible in Editor:"
                for i, range_info in enumerate(
                    visible_ranges[:3]
                ):  # Limit to first 3 ranges
                    if isinstance(range_info, dict):
                        start = range_info.get("start", {})
                        end = range_info.get("end", {})
                        context += f"\n  Range {i+1}: Lines {start.get('line', 0)}-{end.get('line', 0)}"
                if len(visible_ranges) > 3:
                    context += f"\n  ... and {len(visible_ranges) - 3} more visible ranges"

        # Add file content if available (truncated for context)
        if active_file_context.get("content"):
            content = active_file_context["content"]
            if len(content) > 5000:
                context += f"\n\nFile Content (first 5000 chars):\n```\n{content[:5000]}\n...[truncated]\n```"
            else:
                context += f"\n\nFile Content:\n```\n{content}\n```"

        context += "\n=== END ACTIVE FILE CONTEXT ===\n"
    except Exception as e:
        context = str(active_file_context)
    return context


def format_additional_context(additional_context) -> str:
    """Format additional on-demand context for inclusion in system prompt"""
    if not additional_context:
        return ""
    try:
        context = "\n=== ADDITIONAL CONTEXT ===\n"
        print(f"Additional context type: {type(additional_context)}")

        # Format problems context
        if "problems" in additional_context:
            problems = additional_context["problems"]
            context += "\n--- PROBLEMS/DIAGNOSTICS ---\n"
            if problems and isinstance(problems, list):
                for problem in problems[:10]:  # Limit to 10 problems
                    severity = problem.get("severity", "unknown")
                    source = problem.get("source", "unknown")
                    message = problem.get("message", "No message")
                    file_path = problem.get("file", "unknown file")
                    line = problem.get("line", 0)
                    context += f"  [{severity.upper()}] {source}: {message} ({file_path}:{line})\n"
                if len(problems) > 10:
                    context += f"  ... and {len(problems) - 10} more problems\n"
            else:
                context += "  No problems detected\n"

        # Format git context
        if "git" in additional_context:
            git_info = additional_context["git"]
            context += "\n--- GIT CONTEXT ---\n"
            if git_info:
                context += f"  Repository: {git_info.get('isRepo', False)}\n"
                if git_info.get("isRepo"):
                    context += (
                        f"  Branch: {git_info.get('branch', 'unknown')}\n"
                    )
                    context += (
                        f"  Has Changes: {git_info.get('hasChanges', False)}\n"
                    )
                    if git_info.get("changedFiles"):
                        context += f"  Changed Files ({len(git_info['changedFiles'])}):\n"
                        for file_change in git_info["changedFiles"][
                            :5
                        ]:  # Limit to 5 files
                            context += f"    {file_change.get('status', '?')} {file_change.get('path', 'unknown')}\n"
            else:
                context += "  No git repository detected\n"

        # Format project structure context
        if "project-structure" in additional_context:
            structure = additional_context["project-structure"]
            context += "\n--- PROJECT STRUCTURE ---\n"
            if structure and structure.get("tree"):
                context += f"Project tree:\n{structure['tree']}\n"
            else:
                context += "  No project structure available\n"

        # Format open files context
        if "open-files" in additional_context:
            open_files = additional_context["open-files"]
            context += "\n--- OPEN FILES ---\n"
            if open_files and isinstance(open_files, list):
                context += f"  {len(open_files)} files currently open:\n"
                for file_info in open_files[:10]:  # Limit to 10 files
                    path = file_info.get("path", "unknown")
                    language = file_info.get("languageId", "unknown")
                    is_dirty = file_info.get("isDirty", False)
                    dirty_indicator = " (unsaved)" if is_dirty else ""
                    context += f"    {path} ({language}){dirty_indicator}\n"
                if len(open_files) > 10:
                    context += (
                        f"    ... and {len(open_files) - 10} more files\n"
                    )
            else:
                context += "  No open files\n"

        context += "=== END ADDITIONAL CONTEXT ===\n"
    except Exception as e:
        return str(additional_context)
    return context
