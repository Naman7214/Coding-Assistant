import json
from typing import Annotated, List, Optional

import click
from dotenv import load_dotenv
from fastmcp import FastMCP
from pydantic import Field

load_dotenv()
from system.mcp_server.tools.context_tools import (
    get_git_context_tool,
    get_project_structure_tool,
)
from system.mcp_server.tools.enviornment_tools import run_terminal_command_tool
from system.mcp_server.tools.external_tools import web_search_tool
from system.mcp_server.tools.file_access_tools import (
    delete_file_tool,
    list_directory_tool,
    read_file_tool,
    search_files_tool,
)
from system.mcp_server.tools.modification_tools import (
    edit_file_tool,
    reapply_tool,
    search_and_replace_tool,
)
from system.mcp_server.tools.search_tools import (
    codebase_search_tool,
    execute_grep_search_tool,
)
from system.mcp_server.utils.logger import logger

# Create a FastMCP server instance
mcp = FastMCP(name="mcp-tool-server")


@mcp.tool()
async def grep_search(
    query: Annotated[str, Field(description="The query to search for")],
    include_pattern: Annotated[
        Optional[str],
        Field(
            description="Glob pattern for files to include (e.g. '*.ts' for TypeScript files)"
        ),
    ],
    exclude_pattern: Annotated[
        Optional[str], Field(description="Glob pattern for files to exclude")
    ],
    explanation: Annotated[
        Optional[str],
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ],
    workspace_path: Annotated[
        Optional[str],
        Field(
            description="The workspace path, this is automatically injected by the system"
        ),
    ],
    case_sensitive: Annotated[
        bool, Field(description="Whether to use case-sensitive search")
    ] = False,
) -> str:
    """
    Fast text-based regex search that finds exact pattern matches within files or directories, utilizing the ripgrep command for efficient searching.Results will be formatted in the style of ripgrep and can be configured to include line numbers and content.To avoid overwhelming output, the results are capped at 50 matches.Use the include or exclude patterns to filter the search scope by file type or specific paths.This is best for finding exact text matches or regex patterns.More precise than semantic search for finding specific strings or patterns.This is preferred over semantic search when we know the exact symbol/function name/etc. to search in some set of directories/file types. If you decide to run the grep command then must use this tool.
    """
    logger.info(f"Executing grep search: {query}")
    try:
        result = await execute_grep_search_tool(
            query=query,
            case_sensitive=case_sensitive,
            include_pattern=include_pattern,
            exclude_pattern=exclude_pattern,
            explanation=explanation,
            workspace_path=workspace_path,
        )
    except Exception as e:
        logger.error(f"Error occurred while executing grep_search: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def read_file(
    file_path: Annotated[
        str,
        Field(
            description="The path to the file to be read. This must be an absolute path."
        ),
    ],
    start_line: Annotated[
        Optional[int],
        Field(
            default=1,
            description="The starting line number (1-indexed) to read from the file. If omitted, starts from the beginning.",
        ),
    ] = 0,
    end_line: Annotated[
        Optional[int],
        Field(
            default=150,
            description="The ending line number (1-indexed, exclusive) to stop reading the file.",
        ),
    ] = 150,
    explanation: Annotated[
        Optional[str],
        Field(
            description="explanation message that will be printed before reading the file."
        ),
    ] = None,
    workspace_path: Annotated[
        Optional[str],
        Field(
            description="The workspace path, this is automatically injected by the system"
        ),
    ] = None,
) -> str:
    """
    Reads the contents of a specified file. You may choose to read the a specific range of lines by providing optional start and end line numbers default is 1 and 150. The tool returns the file content.
    When using this tool to gather information, it's your responsibility to ensure you have the COMPLETE context. Specifically, each time you call this command you should:
    - Assess if the contents you viewed are sufficient to proceed with your task.
    - When in doubt, call this tool again to gather more information. Remember that partial file views may miss critical dependencies, imports, or functionality.
    """
    logger.info(f"Reading file: {file_path}")
    try:
        result = await read_file_tool(
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            explanation=explanation,
            workspace_path=workspace_path,
        )
    except Exception as e:
        logger.error(f"Error occurred while reading file: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def run_terminal_command(
    command: Annotated[
        str, Field(description="The terminal command to execute")
    ],
    workspace_path: Annotated[
        str,
        Field(
            description="The workspace path, this is automatically injected by the system"
        ),
    ],
    is_background: Annotated[
        bool,
        Field(
            description="Whether the command should be run in the background"
        ),
    ] = False,
    explanation: Annotated[
        Optional[str],
        Field(
            description="One sentence explanation as to why this command needs to be run and how it contributes to the goal."
        ),
    ] = None,
) -> str:
    """
    PROPOSE a command to run on behalf of the user. If you have this tool, note that you DO have the ability to run commands directly on the USER's system. In using these tools, adhere to the following guidelines:
    1. LOOK IN CHAT HISTORY for your current working directory.
    2. The state will persist between command executions (eg. if you cd in one step, that cwd is persisted next time you invoke this tool).
    3. For ANY commands that would use a pager or require user interaction, you should append  | cat to the command (or whatever is appropriate). Otherwise, the command will break. You MUST do this for: git, less, head, tail, more, etc.
    4. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set is_background to true rather than changing the details of the command.
    5. NEVER use commands that require interactive input. Instead, use non-interactive alternatives:
    - Use "npm create vite@latest my-app -- --template react-ts" instead of "npm create vite@latest"
    - Use "git init" instead of interactive git setup
    - Always include all required flags, options, and parameters in the command
    - If unsure of the exact flags, research the command's non-interactive options first
    6. Be aware that terminal-blocking commands (like "npm run dev", "python -m http.server") will be terminated when the next command runs.
    7. Don't include any newlines in the command.
    """
    logger.info(f"Running terminal command: {command}")
    try:
        result = await run_terminal_command_tool(
            command=command,
            is_background=is_background,
            workspace_path=workspace_path,
            explanation=explanation,
        )
        print(result)
    except Exception as e:
        logger.error(f"Error occurred while running terminal command: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def delete_file(
    path: Annotated[
        str,
        Field(
            description="The absolute path to the file or directory that should be deleted."
        ),
    ],
    explanation: Annotated[
        str,
        Field(
            description="A short explanation describing why this file or directory is being deleted and how it contributes to the overall task."
        ),
    ],
    workspace_path: Annotated[
        Optional[str],
        Field(
            description="The workspace path, this is automatically injected by the system"
        ),
    ] = None,
) -> str:
    """
    Deletes a file at the specified absolute path. The operation will fail gracefully if:
    - The file doesn't exist
    - The operation is rejected for security reasons
    - The file cannot be deleted
    """
    logger.info(f"Deleting file: {path}")
    try:
        result = await delete_file_tool(
            path=path, explanation=explanation, workspace_path=workspace_path
        )
    except Exception as e:
        logger.error(f"Error occurred while deleting file: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def list_directory(
    directory_path: Annotated[
        str,
        Field(
            description="The path of the directory or workspace path to list."
        ),
    ],
    explanation: Annotated[
        str,
        Field(
            description="A short explanation of why this directory listing is being performed and how it supports the overall goal."
        ),
    ],
) -> str:
    """
    List the contents of a directory. The quick tool to use for discovery, before using more targeted tools like semantic search or file reading. Useful to try to understand the file structure before diving deeper into specific files. This tool can be most useful to explore the codebase.
    """
    logger.info(f"Listing directory: {directory_path}")
    try:
        result = await list_directory_tool(
            directoryPath=directory_path, explanation=explanation
        )
    except Exception as e:
        logger.error(f"Error occurred while listing directory: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def search_and_replace(
    query: Annotated[
        str, Field(description="The text or regex pattern to search for")
    ],
    replacement: Annotated[
        str, Field(description="The text to replace the matched content with")
    ],
    explanation: Annotated[
        str,
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ],
    workspace_path: Annotated[
        Optional[str],
        Field(
            description="The workspace path, this is automatically injected by the system"
        ),
    ] = None,
    case_sensitive: Annotated[
        bool, Field(description="Whether to use case-sensitive search")
    ] = False,
    include_pattern: Annotated[
        Optional[str], Field(description="Glob pattern for files to include")
    ] = "*",
    exclude_pattern: Annotated[
        Optional[str], Field(description="Glob pattern for files to exclude")
    ] = "",
    search_paths: Annotated[
        Optional[List[str]],
        Field(description="List of paths to search for files"),
    ] = [],
) -> str:
    """
    A tool for searching pattern in files and replace it with new text. this tool allows you to perform search and replace operation across files in codebase. you can specify file patterns to include/exclude and whether to do case-sensitive matching.
    WHEN TO USE:
    - Making identical changes across multiple files (e.g., renaming variables, functions, or imports)
    - Updating API endpoints, configuration values, or constants throughout the project
    - Refactoring patterns that appear in many locations
    """
    logger.info(f"Performing search and replace: {query} -> {replacement}")
    try:
        options = {
            "case_sensitive": case_sensitive,
            "include_pattern": include_pattern,
            "exclude_pattern": exclude_pattern,
            "search_paths": search_paths,
        }
        result = await search_and_replace_tool(
            query=query,
            replacement=replacement,
            explanation=explanation,
            workspace_path=workspace_path,
            options=options,
        )
    except Exception as e:
        logger.error(f"Error occurred while searching and replacing: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def search_files(
    query: Annotated[str, Field(description="Fuzzy filename to search for")],
    explanation: Annotated[
        str,
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ],
    workspace_path: Annotated[
        Optional[str],
        Field(
            description="The workspace path, this is automatically injected by the system"
        ),
    ] = None,
) -> str:
    """
    Fast file search based on fuzzy matching against file path. Use if you know part of the file path but don't know where it's located exactly. Response will be capped to 10 results. Make your query more specific if need to filter results further.
    """
    logger.info(f"Searching files with query: {query}")
    try:
        result = await search_files_tool(
            query=query, explanation=explanation, workspace_path=workspace_path
        )
    except Exception as e:
        logger.error(f"Error occurred while searching files: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def web_search(
    search_term: Annotated[
        str,
        Field(
            description="The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant."
        ),
    ],
    explanation: Annotated[
        Optional[str],
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ] = None,
    target_urls: Annotated[
        Optional[List[str]],
        Field(
            description="Target urls to search on if this is given means this links will be directly used to search on."
        ),
    ] = [],
) -> str:
    """
    Search the web for real-time information about any topic. Use this tool when you need up-to-date information that might not be available in your training data, or when you need to verify current facts. The search results will include relevant snippets and URLs from web pages. This is particularly useful for questions about current events, technology updates, or any topic that requires recent information. You can also specify target urls to search on. if target_urls are given then content of only those url will be used to search on.
    """
    logger.info(f"Performing web search: {search_term}")
    try:
        result = await web_search_tool(
            search_term=search_term,
            explanation=explanation,
            target_urls=target_urls,
        )
    except Exception as e:
        logger.error(f"Error occurred while searching the web: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def codebase_search(
    query: Annotated[
        str,
        Field(
            description="The search query to find relevant code. You should reuse the user's exact query/most recent message with their wording unless there is a clear reason not to."
        ),
    ],
    explanation: Annotated[
        str,
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ],
    hashed_workspace_path: Annotated[
        Optional[str],
        Field(
            description="The hashed path to the workspace the system will automatically inject the hashed workspace path, so you don't need to provide it explicitly."
        ),
    ] = None,
    git_branch: Annotated[
        Optional[str],
        Field(
            description="The git branch to search in. The system will automatically inject the git branch you don't need to provide it explicitly."
        ),
    ] = "default",
) -> str:
    """
    Find snippets of code from the codebase most relevant to the search query. This is a semantic search tool, so the query should ask for something semantically matching what is needed. Unless there is a clear reason to use your own search query, please just reuse the user's exact query with their wording. Their exact wording/phrasing can often be helpful for the semantic search query. Keeping the same exact question format can also be helpful.
    """
    logger.info(f"Searching codebase with query: {query}")
    try:
        result = await codebase_search_tool(
            query=query,
            explanation=explanation,
            hashed_workspace_path=hashed_workspace_path,
            git_branch=git_branch,
        )
    except Exception as e:
        logger.error(f"Error occurred while searching the codebase: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def edit_file(
    target_file_path: Annotated[
        str,
        Field(
            description="The target file to modify. Always specify the target file as the first argument. You are supposed to use absolute path. If an absolute path is provided, it will be preserved as is. if the file is not present then it will be created."
        ),
    ],
    code_snippet: Annotated[
        str,
        Field(
            description="Specify ONLY the precise lines of code that you wish to edit."
        ),
    ],
    explanation: Annotated[
        str,
        Field(
            description="A single sentence instruction describing what you are going to do for the sketched edit."
        ),
    ],
) -> str:
    """
    Use this tool to propose an edit to an existing file or write the content in a new file. This will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write. You should still bias towards repeating as few lines of the original file as possible to convey the change. But, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity. Make sure it is clear what the edit should be, and where it should be applied.

    IMPORTANT: If you need to make multiple changes to the same file, COMBINE ALL CHANGES into a SINGLE tool call. Do NOT use this tool multiple times for the same file - consolidate all modifications, additions, and deletions into one comprehensive edit by following the below formatting requirements.

    CRITICAL FORMATTING REQUIREMENTS:
    - For ADDITIONS/MODIFICATIONS: Include 3 lines of UNCHANGED code above and below your new/modified code to provide precise context for placement
    - For DELETIONS: Show the code block WITH the target lines already removed, including 3 unchanged context lines around the deletion area
    - The FastApply model needs this context to accurately locate where changes should be applied
    """
    logger.info(f"Editing file: {target_file_path}")
    try:
        result = await edit_file_tool(
            target_file_path=target_file_path, code_snippet=code_snippet
        )
    except Exception as e:
        logger.error(f"Error occurred while editing file: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def reapply(
    target_file_path: Annotated[
        str,
        Field(
            description="The target file to modify. Always specify the target file as the first argument. You are supposed to use absolute path. If an absolute path is provided, it will be preserved as is."
        ),
    ],
    code_snippet: Annotated[
        str,
        Field(
            description="Specify ONLY the precise lines of code that you wish to edit. **NEVER specify or write out unchanged code**."
        ),
    ],
    explanation: Annotated[
        str,
        Field(
            description="A single sentence instruction describing what you are going to do for the sketched edit."
        ),
    ],
) -> str:
    """
    Calls a smarter model to apply the last edit to the specified file. Use this tool immediately after the result of an edit_file tool call ONLY IF the diff is not what you expected, indicating the model applying the changes was not smart enough to follow your instructions.
    """
    logger.info(f"Reapplying changes to file: {target_file_path}")
    try:
        result = await reapply_tool(
            target_file_path=target_file_path, code_snippet=code_snippet
        )
    except Exception as e:
        logger.error(f"Error occurred while reapplying changes: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def get_project_structure(
    explanation: Annotated[
        str,
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ],
    max_depth: Annotated[
        int,
        Field(
            description="Maximum depth to traverse the directory structure (default: 8)",
            ge=1,
            le=20,
        ),
    ] = 8,
) -> str:
    """
    Returns the hierarchical project structure of the codebase up to a specified depth.
    This tool provides a tree-like view of directories and files to help understand the overall organization of the project.
    Useful for getting an overview of the codebase structure before diving into specific files or performing targeted searches.
    """
    logger.info(f"Getting project structure with max depth: {max_depth}")
    try:
        result = await get_project_structure_tool(max_depth=max_depth)
    except Exception as e:
        logger.error(f"Error occurred while getting project structure: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@mcp.tool()
async def get_git_context(
    explanation: Annotated[
        str,
        Field(
            description="One sentence explanation as to why this tool is being used, and how it contributes to the goal."
        ),
    ],
    include_changes: Annotated[
        bool,
        Field(
            description="Whether to include diff information in the response (default: False)"
        ),
    ] = False,
) -> str:
    """
    This tool provides information about the current git repository state, recent commits, file changes and can optionally include detailed diff information. default include_changes is False.
    Useful for understanding the current state of version control and recent development activity.
    """
    logger.info(f"Getting git context with include_changes: {include_changes}")
    try:
        result = await get_git_context_tool(include_changes=include_changes)
    except Exception as e:
        logger.error(f"Error occurred while getting git context: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=1)
    return json_output


@click.command()
@click.option("--port", default=8001, help="Port to listen on for SSE")
def main(port: int) -> int:
    """Main entry point for the MCP Tool Server"""
    logger.info(f"Starting MCP Tool Server on port {port}...")
    logger.info("Available tools:")

    # Run the server with SSE transport on the specified port
    mcp.run(transport="sse", port=port, host="0.0.0.0")
    return 0


if __name__ == "__main__":
    main()
