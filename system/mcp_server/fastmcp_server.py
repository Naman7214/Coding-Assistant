import json
import logging
from typing import Optional

import click
from dotenv import load_dotenv
from fastmcp import FastMCP

load_dotenv()
from system.mcp_server.tools.enviornment_tools import run_terminal_command_tool
from system.mcp_server.tools.file_access_tools import (
    list_directory_tool,
    read_file_tool,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Create a FastMCP server instance
mcp = FastMCP(name="mcp-tool-server")


# # Define tools using the @mcp.tool() decorator
# @mcp.tool()
# async def grep_search(
#     query: str,
#     case_sensitive: bool = True,
#     include_pattern: Optional[str] = None,
#     exclude_pattern: Optional[str] = None,
#     explanation: Optional[str] = None,
#     workspace_path: Optional[str] = None,
# ) -> str:
#     """
#     This is best for finding exact text matches or regex patterns.
#     This is preferred over semantic search when we know the exact symbol/function name/etc. to search in some set of directories/file types.
#     Use this tool to run fast, exact regex searches over text files using the `ripgrep` engine.
#     To avoid overwhelming output, the results are capped at 50 matches.
#     Use the include or exclude patterns to filter the search scope by file type or specific paths.
#     """
#     logger.info(f"Executing grep search: {query}")
#     try:
#         result = await execute_grep_search_tool(
#             query=query,
#             case_sensitive=case_sensitive,
#             include_pattern=include_pattern,
#             exclude_pattern=exclude_pattern,
#             explanation=explanation,
#             workspace_path=workspace_path,
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while executing grep_search: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


@mcp.tool()
async def read_file(
    file_path: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
    explanation: Optional[str] = None,
    workspace_path: Optional[str] = None,
) -> str:
    """
    Reads the contents of a specified file. You may choose to read the entire file or a specific range of lines
    by providing optional start and end line numbers. The tool returns the file content.
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

    json_output = json.dumps(result, indent=2)
    return json_output


@mcp.tool()
async def run_terminal_command(
    command: str,
    is_background: bool,
    workspace_path: str,
    explanation: Optional[str] = None,
) -> str:
    """
    PROPOSE a command to run on behalf of the user.
    If you have this tool, note that you DO have the ability to run commands directly on the USER's system.
    In using these tools, adhere to the following guidelines:
    1. Commands will be executed in a predefined path set by the system.
    2. The state will persist between command executions (eg. if you cd in one step, that cwd is persisted next time you invoke this tool).
    3. For ANY commands that would use a pager or require user interaction, you should append | cat to the command (or whatever is appropriate). Otherwise, the command will break. You MUST do this for: git, less, head, tail, more, etc.
    4. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set is_background to true rather than changing the details of the command.
    5. Don't include any newlines in the command.
    """
    logger.info(f"Running terminal command: {command}")
    try:
        result = await run_terminal_command_tool(
            command=command,
            is_background=is_background,
            workspace_path=workspace_path,
            explanation=explanation,
        )
    except Exception as e:
        logger.error(f"Error occurred while running terminal command: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=2)
    return json_output


# @mcp.tool()
# async def delete_file(
#     path: str, explanation: str, workspace_path: Optional[str] = None
# ) -> str:
#     """
#     Deletes a file or directory at the specified path with strict safety checks.
#     Protected system or project-critical paths (e.g., node_modules, .env, src) and hidden/system files cannot be deleted.
#     The tool returns the deletion status and an error message if the deletion is rejected or fails.
#     """
#     logger.info(f"Deleting file: {path}")
#     try:
#         result = await delete_file_tool(
#             path=path, explanation=explanation, workspace_path=workspace_path
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while deleting file: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


@mcp.tool()
async def list_directory(
    dir_path: str, explanation: str, workspace_path: Optional[str] = None
) -> str:
    """
    List the contents of a directory. The quick tool to use for discovery, before using more targeted tools like semantic search or file reading.
    Useful to try to understand the file structure before diving deeper into specific files.
    Can be used to explore the codebase. The tool returns a JSON array of file paths.
    """
    logger.info(f"Listing directory: {dir_path}")
    try:
        result = await list_directory_tool(
            dir_path=dir_path,
            explanation=explanation,
            workspace_path=workspace_path,
        )
    except Exception as e:
        logger.error(f"Error occurred while listing directory: {e}")
        result = {"error": str(e)}

    json_output = json.dumps(result, indent=2)
    return json_output


# @mcp.tool()
# async def search_and_replace(
#     query: str,
#     replacement: str,
#     explanation: str,
#     workspace_path: str,
#     options: Dict[str, Any] = None,
# ) -> str:
#     """
#     A tool for searching pattern in files and replace it with new text.
#     This tool allows you to perform search and replace operation across files in codebase.
#     You can specify file patterns to include/exclude and whether to do case-sensitive matching.
#     """
#     logger.info(f"Performing search and replace: {query} -> {replacement}")
#     try:
#         result = await search_and_replace_tool(
#             query=query,
#             replacement=replacement,
#             explanation=explanation,
#             workspace_path=workspace_path,
#             options=options,
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while searching and replacing: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


# @mcp.tool()
# async def search_files(
#     query: str, explanation: str, workspace_path: str
# ) -> str:
#     """
#     Fast file search based on fuzzy matching against file path.
#     Use if you know part of the file path but don't know where it's located exactly.
#     Response will be capped to 10 results. Make your query more specific if need to filter results further.
#     """
#     logger.info(f"Searching files with query: {query}")
#     try:
#         result = await search_files_tool(
#             query=query, explanation=explanation, workspace_path=workspace_path
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while searching files: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


# @mcp.tool()
# async def web_search(
#     search_term: str,
#     explanation: Optional[str] = None,
#     target_urls: Optional[List[str]] = None,
# ) -> str:
#     """
#     Search the web for real-time information about any topic.
#     Use this tool when you need up-to-date information that might not be available in your training data,
#     or when you need to verify current facts. The search results will include relevant snippets and URLs from web pages.
#     This is particularly useful for questions about current events, technology updates, or any topic that requires recent information.
#     You can also specify target urls to search on. If target_urls are given then content of only those url will be used to search on.
#     """
#     logger.info(f"Performing web search: {search_term}")
#     try:
#         result = await web_search_tool(
#             search_term=search_term,
#             explanation=explanation,
#             target_urls=target_urls,
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while searching the web: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


# @mcp.tool()
# async def codebase_search(
#     query: str, explanation: str, target_directories: Optional[List[str]] = None
# ) -> str:
#     """
#     Find snippets of code from the codebase most relevant to the search query.
#     This is a semantic search tool, so the query should ask for something semantically matching what is needed.
#     If it makes sense to only search in particular directories, please specify them in the target_directories field.
#     Unless there is a clear reason to use your own search query, please just reuse the user's exact query with their wording.
#     Their exact wording/phrasing can often be helpful for the semantic search query. Keeping the same exact question format can also be helpful.
#     """
#     logger.info(f"Searching codebase with query: {query}")
#     try:
#         result = await codebase_search_tool(
#             query=query,
#             explanation=explanation,
#             target_directories=target_directories,
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while searching the codebase: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


# @mcp.tool()
# async def edit_file(
#     target_file_path: str,
#     code_snippet: str,
#     explanation: str,
#     workspace_path: Optional[str] = None,
# ) -> str:
#     """
#     Use this tool to propose an edit to an existing file.
#     This will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is,
#     while also minimizing the unchanged code you write.
#     When writing the edit, you should specify each edit in sequence, with the special comment `// ... existing code ...`
#     to represent unchanged code in between edited lines.
#     You should still bias towards repeating as few lines of the original file as possible to convey the change.
#     But, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.
#     DO NOT omit spans of pre-existing code (or comments) without using the `// ... existing code ...` comment to indicate its absence.
#     If you omit the existing code comment, the model may inadvertently delete these lines.
#     Make sure it is clear what the edit should be, and where it should be applied.
#     """
#     logger.info(f"Editing file: {target_file_path}")
#     try:
#         result = await edit_file_tool(
#             target_file_path=target_file_path,
#             code_snippet=code_snippet,
#             explanation=explanation,
#             workspace_path=workspace_path,
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while editing file: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


# @mcp.tool()
# async def reapply(
#     target_file_path: str,
#     code_snippet: str,
#     explanation: str,
#     workspace_path: Optional[str] = None,
# ) -> str:
#     """
#     Calls a smarter model to apply the last edit to the specified file.
#     Use this tool immediately after the result of an edit_file tool call ONLY IF the diff is not what you expected,
#     indicating the model applying the changes was not smart enough to follow your instructions.
#     """
#     logger.info(f"Reapplying changes to file: {target_file_path}")
#     try:
#         result = await reapply_tool(
#             target_file_path=target_file_path,
#             code_snippet=code_snippet,
#             explanation=explanation,
#             workspace_path=workspace_path,
#         )
#     except Exception as e:
#         logger.error(f"Error occurred while reapplying changes: {e}")
#         result = {"error": str(e)}

#     json_output = json.dumps(result, indent=2)
#     return json_output


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
