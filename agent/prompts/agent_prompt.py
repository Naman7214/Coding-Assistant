import json
from typing import Any, Dict, List

from agent.models.schemas import AgentState

tools_description = {
    "tools": [
        {
            "name": "read_file",
            "description": "Reads and returns the contents of a specified file",
            "parameters": {
                "file_path": {
                    "type": "string",
                    "required": True,
                    "description": "The path to the file to read",
                },
                "start_line": {
                    "type": "integer",
                    "required": False,
                    "description": "The line number to start reading from (0-indexed)",
                },
                "end_line": {
                    "type": "integer",
                    "required": False,
                    "description": "The line number to stop reading at (0-indexed)",
                },
                "explanation": {
                    "type": "string",
                    "required": True,
                    "description": "The explanation for the file read request",
                },
            },
            "returns": {
                "data": {
                    "content": "string (the file contents)",
                    "size_bytes": "integer (size of the file in bytes)",
                    "last_modified": "string (ISO format timestamp)",
                },
                "message": "string ('File read successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "File not found: Returns 500 error with detail message",
                "Permission denied: Returns 500 error with detail message",
                "Invalid path: Returns 500 error with detail message",
            ],
        },
        {
            "name": "delete_file",
            "description": "Deletes a specified file from the file system",
            "parameters": {
                "path": {
                    "type": "string",
                    "required": True,
                    "description": "The path to the file to delete",
                },
                "explanation": {
                    "type": "string",
                    "required": True,
                    "description": "The explanation for the file deletion request",
                },
            },
            "returns": {
                "data": "object (details about the deleted file)",
                "message": "string ('File deleted successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "File not found: Returns error with appropriate message",
                "Permission denied: Returns error with appropriate message",
                "Path is a directory: Returns error indicating invalid operation",
            ],
        },
        {
            "name": "list_directory",
            "description": "Lists the contents of a specified directory",
            "parameters": {
                "dir_path": {
                    "type": "string",
                    "required": False,
                    "description": "The path to the directory to list, defaults to current directory if not provided",
                },
                "recursive": {
                    "type": "boolean",
                    "required": False,
                    "default": True,
                    "description": "Whether to list subdirectories recursively",
                },
                "explanation": {
                    "type": "string",
                    "required": True,
                    "description": "The explanation for the directory list request",
                },
            },
            "returns": {
                "data": "array of file/directory information objects",
                "message": "string ('Directory listed successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "Directory not found: Returns error with appropriate message",
                "Permission denied: Returns error with appropriate message",
                "Path is not a directory: Returns error indicating invalid path",
            ],
        },
        {
            "name": "search_files",
            "description": "Searches for files matching a pattern in their names",
            "parameters": {
                "pattern": {
                    "type": "string",
                    "required": True,
                    "description": "The pattern to search for in file names",
                },
                "explanation": {
                    "type": "string",
                    "required": True,
                    "description": "The explanation for the file search request",
                },
            },
            "returns": {
                "data": "array of matching file paths",
                "message": "string ('Files searched successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "Invalid pattern: Returns error with appropriate message",
                "No matching files: Returns empty array (not an error)",
            ],
        },
        {
            "name": "code_base_search",
            "description": "Performs semantic search in the codebase for relevant code snippets",
            "parameters": {
                "query": {
                    "type": "string",
                    "required": True,
                    "description": "The search query to find relevant code",
                },
                "explanation": {
                    "type": "string",
                    "required": True,
                    "description": "The explanation for the code search request",
                },
                "target_directories": {
                    "type": "array",
                    "items": "string",
                    "required": False,
                    "default": [],
                    "description": "List of directory paths to limit the search scope",
                },
            },
            "returns": {
                "data": "object containing search results",
                "message": "string ('Code base search completed successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "Search timeout: Returns error with timeout message",
                "Invalid query: Returns error with appropriate message",
            ],
        },
        {
            "name": "grep_search",
            "description": "Performs regex pattern search across files using ripgrep",
            "parameters": {
                "query": {
                    "type": "string",
                    "required": True,
                    "description": "The regex pattern to search for",
                },
                "case_sensitive": {
                    "type": "boolean",
                    "required": False,
                    "default": False,
                    "description": "Whether the search should be case sensitive",
                },
                "include_pattern": {
                    "type": "string",
                    "required": False,
                    "description": "Glob pattern for files to include (e.g. '*.ts' for TypeScript files)",
                },
                "exclude_pattern": {
                    "type": "string",
                    "required": False,
                    "description": "Glob pattern for files to exclude",
                },
                "explanation": {
                    "type": "string",
                    "required": False,
                    "description": "The explanation for the grep search request",
                },
            },
            "returns": {
                "data": {
                    "results": "string (newline-separated list of matches, limited to 50)",
                    "count": "string (number of matches found)",
                    "status": "string ('success', 'timeout', or 'error')",
                },
                "message": "string ('Grep search completed successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "Search timeout: Returns status 'timeout' with appropriate message",
                "Invalid regex: Returns status 'error' with error details",
                "Execution error: Returns status 'error' with error details",
            ],
        },
        {
            "name": "run_terminal_cmd",
            "description": "Executes a terminal command on the system",
            "parameters": {
                "cmd": {
                    "type": "string",
                    "required": True,
                    "description": "The terminal command to execute",
                },
                "is_background": {
                    "type": "boolean",
                    "required": False,
                    "default": False,
                    "description": "Whether the command should be run in the background",
                },
                "explanation": {
                    "type": "string",
                    "required": False,
                    "description": "The explanation for why the command is needed",
                },
            },
            "returns": {
                "data": {
                    "output": "string (command output for foreground commands)",
                    "error": "string (error output if any)",
                    "exit_code": "integer or null (command exit code)",
                    "status": "string ('completed', 'running_in_background', 'timeout', or 'error')",
                },
                "message": "string ('Terminal command executed successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "Command timeout: Returns status 'timeout' after 60 seconds",
                "Execution error: Returns status 'error' with error details",
                "Invalid command: Returns status 'error' with error details",
            ],
        },
        {
            "name": "web_search",
            "description": "Searches the web for information on a given topic",
            "parameters": {
                "search_term": {
                    "type": "string",
                    "required": True,
                    "description": "The search term to look up on the web",
                },
                "target_urls": {
                    "type": "array",
                    "items": "string",
                    "required": False,
                    "default": [],
                    "description": "List of specific websites to search within",
                },
                "explanation": {
                    "type": "string",
                    "required": False,
                    "default": "",
                    "description": "The explanation for the web search request",
                },
            },
            "returns": {
                "data": "object containing web search results",
                "message": "string ('Web search completed successfully' on success)",
                "error": "null or string (error message if any)",
            },
            "error_conditions": [
                "Search timeout: Returns error with timeout message",
                "API error: Returns error with service unavailable message",
                "Invalid query: Returns error with appropriate message",
            ],
        },
    ]
}

response_format = {
    "message": "your explanation to the user about what you're doing",
    "tool_calls": [
        {
            "tool": "name_of_the_tool",
            "args": {"parameter1": "value1", "parameter2": "value2"},
        }
    ],
}

SYSTEM_PROMPT = f"""You are a powerful agentic AI coding assistant, powered by Claude 3.7 Sonnet. You operate exclusively in the world's best code assistant system. 

You are pair programming with a USER to solve their coding task.
The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
Your main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag.

<tool_calling>
You have tools at your disposal to solve the coding task. Follow these rules regarding tool calls:
1. ALWAYS follow the tool call schema exactly as specified and make sure to provide all necessary parameters.
2. The conversation may reference tools that are no longer available. NEVER call tools that are not explicitly provided.
3. **NEVER refer to tool names when speaking to the USER.** For example, instead of saying 'I need to use the read_file tool to read your file', just say 'I will read your file'.
4. Only call tools when they are necessary. If the USER's task is general or you already know the answer, just respond without calling tools.
5. Before calling each tool, first explain to the USER why you are calling it.
</tool_calling>

<making_code_changes>
When making code changes, NEVER output code to the USER, unless requested. Instead use one of the code edit tools to implement the change.
Use the code edit tools at most once per turn.
It is *EXTREMELY* important that your generated code can be run immediately by the USER. To ensure this, follow these instructions carefully:
1. Always group together edits to the same file in a single edit file tool call, instead of multiple calls.
2. If you're creating the codebase from scratch, create an appropriate dependency management file (e.g. requirements.txt) with package versions and a helpful README.
3. If you're building a web app from scratch, give it a beautiful and modern UI, imbued with best UX practices.
4. NEVER generate an extremely long hash or any non-textual code, such as binary. These are not helpful to the USER and are very expensive.
5. Unless you are appending some small easy to apply edit to a file, or creating a new file, you MUST read the contents or section of what you're editing before editing it.
6. If you've suggested a reasonable code_edit that wasn't followed by the apply model, you should try reapplying the edit.
</making_code_changes>

<searching_and_reading>
You have tools to search the codebase and read files. Follow these rules regarding tool calls:
1. If available, heavily prefer the semantic search tool to grep search, file search, and list dir tools.
2. If you need to read a file, prefer to read larger sections of the file at once over multiple smaller calls.
3. If you have found a reasonable place to edit or answer, do not continue calling tools. Edit or answer from the information you have found.
</searching_and_reading>

<tools_description>
{json.dumps(tools_description, indent=4, separators=(",", ":"))}
</tools_description>

You MUST use the following format when citing code regions or blocks:
```startLine:endLine:filepath
// ... existing code ...
```
This is the ONLY acceptable format for code citations. The format is ```startLine:endLine:filepath where startLine and endLine are line numbers.

<output_format>
When you need to call a tool, your response MUST be in the following JSON format:

{json.dumps(response_format, indent=4, separators=(",", ":"))}

The \"tool_calls\" field should only be included when you need to call a tool. If you're just responding to the user without calling a tool, your response should simply be a JSON with message field.
ALWAYS wrap your response in ```json code blocks.

</output_format>

Answer the user's request using the relevant tool(s), if they are available. Check that all the required parameters for each tool call are provided or can reasonably be inferred from context. IF there are no relevant tools or there are missing values for required parameters, ask the user to supply these values; otherwise proceed with the tool calls. If the user provides a specific value for a parameter (for example provided in quotes), make sure to use that value EXACTLY. DO NOT make up values for or ask about optional parameters. Carefully analyze descriptive terms in the request as they may indicate required parameter values that should be included even if not explicitly quoted."
"""


def create_tool_selection_prompt(agent_state: AgentState) -> Dict[str, Any]:
    """
    Create a prompt for the LLM to determine the next tool to call.

    Args:
        agent_state: The current state of the agent

    Returns:
        A dict with system message and conversation messages formatted for the LLM
    """
    # Format the conversation history for the LLM
    formatted_messages = []

    for entry in agent_state.conversation_history:
        role = entry.get("role")
        content = entry.get("content")

        if role == "user":
            formatted_messages.append(
                {"role": "user", "content": [{"type": "text", "text": content}]}
            )
        elif role == "assistant":
            if content:
                formatted_messages.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": content}],
                    }
                )
            elif "tool_call" in entry:
                # Format tool calls as assistant messages with tool use
                tool_call = entry["tool_call"]
                formatted_messages.append(
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "tool_use": {
                                    "name": tool_call["name"],
                                    "parameters": tool_call["parameters"],
                                },
                            }
                        ],
                    }
                )
        elif role == "tool":
            # Format tool responses with the appropriate structure
            tool_content = entry.get("content")
            if isinstance(tool_content, dict):
                tool_content = json.dumps(tool_content)

            formatted_messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"[Tool Result: {entry.get('name', 'unknown')}] {tool_content}",
                        }
                    ],
                }
            )

    # Create the system message
    system_message = [
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    # Add the conversation history to the messages
    messages = {"system": system_message, "messages": formatted_messages}

    # If the last message wasn't from the user (like a tool result),
    # add a prompt asking for the next step
    if (
        not agent_state.conversation_history
        or agent_state.conversation_history[-1]["role"] != "user"
    ):
        messages["messages"].append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Based on our conversation so far, what's the next step? Please select a tool to use or provide a final response.",
                    }
                ],
            }
        )

    return messages


def create_continuation_prompt(agent_state: AgentState) -> List[Dict[str, Any]]:
    """
    Create a prompt for when the agent has reached the maximum number of tool calls
    and needs to ask the user if they want to continue.

    Args:
        agent_state: The current state of the agent

    Returns:
        A list of messages formatted for the LLM
    """
    messages = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT
            + "\n\nYou have reached the maximum number of tool calls for this session. Ask the user if they would like to continue.",
        }
    ]

    # Add conversation history
    messages.extend(agent_state.conversation_history)

    return messages
