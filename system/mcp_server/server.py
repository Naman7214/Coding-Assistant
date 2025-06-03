import json
import logging

import click
import httpx
import mcp.types as types
import tiktoken
import uvicorn
from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from dotenv import load_dotenv
from mcp.server.lowlevel import Server
from mcp.server.sse import SseServerTransport
from starlette.applications import Starlette
from starlette.routing import Mount, Route

# import aiofiles


load_dotenv()
from system.mcp_server.tools.enviornment_tools import run_terminal_command
from system.mcp_server.tools.external_tools import web_search
from system.mcp_server.tools.file_access_tools import (
    delete_file,
    list_directory,
    read_file,
    search_files,
)
from system.mcp_server.tools.modification_tools import (
    edit_file,
    reapply,
    search_and_replace,
)
from system.mcp_server.tools.search_tools import codebase_search, execute_grep_search

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@click.command()
@click.option("--port", default=8001, help="Port to listen on for SSE")
def main(port: int) -> int:
    """Main entry point for the MCP Tool Server"""

    app = Server("mcp-tool-server")

    @app.call_tool()
    async def tool_handler(
        name: str, arguments: dict
    ) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
        """Handle tool calls based on the tool name"""
        logger.info(f"Tool call: {name} with arguments {arguments}")

        if name == "grep_search":
            if "query" not in arguments:
                raise ValueError("Missing required argument 'query' ")
            result = await execute_grep_search(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]
            # return [
            #     types.TextContent(type="text", text=result["results"]),
            #     types.TextContent(type="text", text=str(result["count"])),
            #     types.TextContent(type="text", text=result["status"])
            # ]

        elif name == "read_file":
            if "file_path" and "explanation" not in arguments:
                raise ValueError(
                    "Missing required argument 'file_path' and 'explanation'"
                )
            result = await read_file(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]
            # return [
            #     types.TextContent(type="text", text=result["content"]),
            #     types.TextContent(type="text", text=str(result["size_bytes"])),
            #     types.TextContent(type="text", text=result["last_modified"])
            # ]

        elif name == "run_terminal_command":
            required_args = ["command", "is_background"]
            for arg in required_args:
                if arg not in arguments:
                    raise ValueError(f"Missing required argument :'{arg}' ")
            result = await run_terminal_command(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]
            # return [
            #     types.TextContent(type="text", text=result["output"]),
            #     types.TextContent(type="text", text=result.get("error", "")),
            #     types.TextContent(type="text", text=str(result.get("exit_code",""))),
            #     types.TextContent(type="text", text=result.get("status"))
            # ]

        elif name == "delete_file":
            if "path" and "explanation" not in arguments:
                raise ValueError(
                    "Missing required argument 'path' and 'explanation'"
                )
            result = await delete_file(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]
            # return [
            #     types.TextContent(type="text", text=result.get("deleted", "")),
            #     types.TextContent(type="text", text=result.get("error", ""))
            # ]

        elif name == "list_directory":
            result = await list_directory(**arguments)

            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        elif name == "search_and_replace":
            if "query" and "replacement" and "explanation" not in arguments:
                raise ValueError(
                    "Missing required argument 'query' and 'replacement' and 'explanation'"
                )
            result = await search_and_replace(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        elif name == "search_files":
            if "query" and "explanation" not in arguments:
                raise ValueError("Missing required argument 'query'")
            result = await search_files(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        elif name == "web_search":
            if "search_term" and "explanation" not in arguments:
                raise ValueError("Missing required argument 'search_term'")
            result = await web_search(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        elif name == "codebase_search":
            if "query" and "explanation" not in arguments:
                raise ValueError(
                    "Missing required argument 'query' and 'explanation' "
                )
            result = await codebase_search(**arguments)
            print(f"result in elif codebase_search: {result}")
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        elif name == "edit_file":
            if (
                "target_file_path"
                and "code_snippet"
                and "explanation" not in arguments
            ):
                raise ValueError(
                    "Missing required argument 'target_file_path' and 'code_snippet' and 'explanation'"
                )
            result = await edit_file(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        elif name == "reapply":
            if (
                "target_file_path"
                and "code_snippet"
                and "explanation" not in arguments
            ):
                raise ValueError(
                    "Missing required argument 'target_file_path' and 'code_snippet' and 'explanation'"
                )
            result = await reapply(**arguments)
            json_output = json.dumps(result, indent=2)
            return [types.TextContent(type="text", text=json_output)]

        # elif name == "extract_text":
        #     if "html" not in arguments:
        #         raise ValueError("Missing required argument 'html'")
        #     return await extract_text(arguments["html"])

        else:
            raise ValueError(f"Unknown tool: {name}")

    @app.list_tools()
    async def list_tools() -> list[types.Tool]:
        """List available tools with their descriptions and input schemas"""
        return [
            types.Tool(
                name="grep_search",
                description="This is best for finding exact text matches or regex patterns. This is preferred over semantic search when we know the exact symbol/function name/etc. to search in some set of directories/file types. Use this tool to run fast, exact regex searches over text files using the `ripgrep` engine. To avoid overwhelming output, the results are capped at 50 matches. Use the include or exclude patterns to filter the search scope by file type or specific paths.",
                inputSchema={
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The regex pattern to search for",
                        },
                        "case_sensitive": {
                            "type": "boolean",
                            "description": "Whether the search should be case sensitive",
                        },
                        "include_pattern": {
                            "type": "string",
                            "description": "Glob pattern for files to include (e.g. '*.ts' for TypeScript files)",
                        },
                        "exclude_pattern": {
                            "type": "string",
                            "description": "Glob pattern for files to exclude",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
                        },
                    },
                },
            ),
            types.Tool(
                name="read_file",
                description="Reads the contents of a specified file. You may choose to read the entire file or a specific range of lines by providing optional start and end line numbers. The tool returns the file content.",
                inputSchema={
                    "type": "object",
                    "required": ["file_path", "explanation"],
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "title": "File Path",
                            "description": "The path to the file to be read. This must be an absolute path.",
                        },
                        "start_line": {
                            "type": "integer",
                            "title": "Start Line",
                            "description": "The starting line number (0-indexed) to read from the file. If omitted, starts from the beginning.",
                        },
                        "end_line": {
                            "type": "integer",
                            "title": "End Line",
                            "description": "The ending line number (0-indexed, exclusive) to stop reading the file. If omitted, reads to the end.",
                        },
                        "explanation": {
                            "type": "string",
                            "title": "Explanation",
                            "description": "explanation message that will be printed before reading the file.",
                        },
                    },
                },
            ),
            types.Tool(
                name="run_terminal_command",
                description="PROPOSE a command to run on behalf of the user.\nIf you have this tool, note that you DO have the ability to run commands directly on the USER's system.\nIn using these tools, adhere to the following guidelines:\n1. Commands will be executed in a preined path set by the system.\n2. The state will persist between command executions (eg. if you cd in one step, that cwd is persisted next time you invoke this tool).\n3. For ANY commands that would use a pager or require user interaction, you should append  | cat to the command (or whatever is appropriate). Otherwise, the command will break. You MUST do this for: git, less, head, tail, more, etc.\n4. For commands that are long running/expected to run ininitely until interruption, please run them in the background. To run jobs in the background, set is_background to true rather than changing the details of the command.\n5. Dont include any newlines in the command.",
                inputSchema={
                    "type": "object",
                    "required": ["command", "is_background", "workspace_path"],
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The terminal command to execute",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
                        },
                        "is_background": {
                            "type": "boolean",
                            "description": "Whether the command should be run in the background",
                        },
                        "workspace_path": {
                            "type": "string",
                            "description": "The path to the workspace",
                        }
                    },
                },
            ),
            types.Tool(
                name="delete_file",
                description="Deletes a file or directory at the specified path with strict safety checks. Protected system or project-critical paths (e.g., node_modules, .env, src) and hidden/system files cannot be deleted. The tool returns the deletion status and an error message if the deletion is rejected or fails.",
                inputSchema={
                    "type": "object",
                    "required": ["path", "explanation"],
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The absolute path to the file or directory that should be deleted.",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "A short explanation describing why this file or directory is being deleted and how it contributes to the overall task.",
                        },
                    },
                },
            ),
            types.Tool(
                name="list_directory",
                description="List the contents of a directory. The quick tool to use for discovery, before using more targeted tools like semantic search or file reading. Useful to try to understand the file structure before diving deeper into specific files. Can be used to explore the codebase. The tool returns a JSON array of file paths.",
                inputSchema={
                    "type": "object",
                    "required": ["dir_path", "explanation"],
                    "properties": {
                        "dir_path": {
                            "type": "string",
                            "description": "The path of the directory to list. If not provided, the current working directory is used.",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "A short explanation of why this directory listing is being performed and how it supports the overall goal.",
                        },
                    },
                },
            ),
            types.Tool(
                name="search_and_replace",
                description="A tool for searching pattern in files and replace it with new text. this tool allows you to perform search and replace operation across files in codebase. you can specify file patterns to include/exclude and whether to do case-sensitive matching.",
                inputSchema={
                    "type": "object",
                    "required": ["query", "replacement", "explanation", "workspace_path"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The text or regex pattern to search for",
                        },
                        "replacement": {
                            "type": "string",
                            "description": "The text to replace the matched content with",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
                        },
                        "workspace_path": {
                            "type": "string",
                            "description": "The path to the workspace",
                        },
                        "options": {
                            "type": "object",
                            "properties": {
                                "case_sensitive": {
                                    "type": "boolean",
                                    "description": "Whether the search should be case sensitive",
                                    "ault": True,
                                },
                                "include_pattern": {
                                    "type": "string",
                                    "description": "Glob pattern for files to include (e.g., '*.js' for JavaScript files)",
                                },
                                "exclude_pattern": {
                                    "type": "string",
                                    "description": "Glob pattern for files to exclude",
                                },
                                "search_paths": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Paths to search in (aults to current directory)",
                                },
                            },
                        },
                    },
                },
            ),
            types.Tool(
                name="search_files",
                description="Fast file search based on fuzzy matching against file path. Use if you know part of the file path but don't know where it's located exactly. Response will be capped to 10 results. Make your query more specific if need to filter results further.",
                inputSchema={
                    "type": "object",
                    "required": ["query", "explanation", "workspace_path"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Fuzzy filename to search for",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
                        },
                        "workspace_path": {
                            "type": "string",
                            "description": "The path to the workspace",
                        },
                    },
                },
            ),
            types.Tool(
                name="web_search",
                description="Search the web for real-time information about any topic. Use this tool when you need up-to-date information that might not be available in your training data, or when you need to verify current facts. The search results will include relevant snippets and URLs from web pages. This is particularly useful for questions about current events, technology updates, or any topic that requires recent information. You can also specify target urls to search on. if target_urls are given then content of only those url will be used to search on.",
                inputSchema={
                    "type": "object",
                    "required": ["search_term"],
                    "properties": {
                        "search_term": {
                            "type": "string",
                            "description": "The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.",
                        },
                        "target_urls": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Target urls to search on if this is given means this links will be directly used to search on.",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
                        },
                    },
                },
            ),
            types.Tool(
                name="codebase_search",
                description="Find snippets of code from the codebase most relevant to the search query.\nThis is a semantic search tool, so the query should ask for something semantically matching what is needed.\nIf it makes sense to only search in particular directories, please specify them in the target_directories field.\nUnless there is a clear reason to use your own search query, please just reuse the user's exact query with their wording.\nTheir exact wording/phrasing can often be helpful for the semantic search query. Keeping the same exact question format can also be helpful.",
                inputSchema={
                    "type": "object",
                    "required": ["query", "explanation"],
                    "properties": {
                        "explanation": {
                            "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
                            "type": "string",
                        },
                        "query": {
                            "description": "The search query to find relevant code. You should reuse the user's exact query/most recent message with their wording unless there is a clear reason not to.",
                            "type": "string",
                        },
                        "target_directories": {
                            "description": "Glob patterns for directories to search over",
                            "items": {"type": "string"},
                            "type": "array",
                        },
                    },
                },
            ),
            types.Tool(
                name="edit_file",
                description="Use this tool to propose an edit to an existing file.\n\nThis will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.\nWhen writing the edit, you should specify each edit in sequence, with the special comment `// ... existing code ...` to represent unchanged code in between edited lines.\n\nFor example:\n\n```\n// ... existing code ...\nFIRST_EDIT\n// ... existing code ...\nSECOND_EDIT\n// ... existing code ...\nTHIRD_EDIT\n// ... existing code ...\n```\n\nYou should still bias towards repeating as few lines of the original file as possible to convey the change.\nBut, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.\nDO NOT omit spans of pre-existing code (or comments) without using the `// ... existing code ...` comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these lines.\nMake sure it is clear what the edit should be, and where it should be applied.\n\nYou MUST provide the following required arguments: target_file_path (the file to edit), code_snippet (your proposed changes), and explanation (why you're making these changes). The target_file_path should always be specified first, followed by the code_snippet and explanation.",
                inputSchema={
                    "type": "object",
                    "required": [
                        "target_file_path",
                        "code_snippet",
                        "explanation",
                    ],
                    "properties": {
                        "target_file_path": {
                            "type": "string",
                            "description": "The target file to modify. Always specify the target file as the first argument. You are supposed to use absolute path. If an absolute path is provided, it will be preserved as is.",
                        },
                        "code_snippet": {
                            "type": "string",
                            "description": "Specify ONLY the precise lines of code that you wish to edit. **NEVER specify or write out unchanged code**. Instead, represent all unchanged code using the comment of the language you're editing in - example: `// ... existing code ...`",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "A single sentence instruction describing what you are going to do for the sketched edit. This is used to assist the less intelligent model in applying the edit. Please use the first person to describe what you are going to do. Dont repeat what you have said previously in normal messages. And use it to disambiguate uncertainty in the edit.",
                        },
                    },
                },
            ),
            types.Tool(
                name="reapply",
                description="Calls a smarter model to apply the last edit to the specified file.\nUse this tool immediately after the result of an edit_file tool call ONLY IF the diff is not what you expected, indicating the model applying the changes was not smart enough to follow your instructions.",
                inputSchema={
                    "type": "object",
                    "required": [
                        "target_file_path",
                        "code_snippet",
                        "explanation",
                    ],
                    "properties": {
                        "target_file_path": {
                            "type": "string",
                            "description": "The target file to modify. Always specify the target file as the first argument. You are supposed to use absolute path. If an absolute path is provided, it will be preserved as is.",
                        },
                        "code_snippet": {
                            "type": "string",
                            "description": "Specify ONLY the precise lines of code that you wish to edit. **NEVER specify or write out unchanged code**. Instead, represent all unchanged code using the comment of the language you're editing in - example: `// ... existing code ...`",
                        },
                        "explanation": {
                            "type": "string",
                            "description": "A single sentence instruction describing what you are going to do for the sketched edit. This is used to assist the less intelligent model in applying the edit. Please use the first person to describe what you are going to do. Dont repeat what you have said previously in normal messages. And use it to disambiguate uncertainty in the edit.",
                        },
                    },
                },
            ),
        ]

    # Set up SSE transport
    sse = SseServerTransport("/messages/")

    async def handle_sse(request):
        """Handle SSE connections"""
        async with sse.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await app.run(
                streams[0], streams[1], app.create_initialization_options()
            )

    # Create Starlette app with SSE routes
    starlette_app = Starlette(
        debug=True,
        routes=[
            Route("/sse", endpoint=handle_sse),
            Mount("/messages/", app=sse.handle_post_message),
        ],
    )

    logger.info(f"Starting MCP Tool Server on port {port}...")
    logger.info("Available tools:")
    # for tool in app.list_tools_sync():
    #     logger.info(f"- {tool.name}: {tool.description}")

    # Run with Uvicorn
    uvicorn.run(starlette_app, host="0.0.0.0", port=port)  # 192.168.17.182

    return 0


if __name__ == "__main__":
    main()
