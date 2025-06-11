# import asyncio

# from mcp.client.session import ClientSession
# from mcp.client.sse import sse_client


# async def main():
#     async with sse_client(
#         "http://localhost:8001/sse"
#     ) as streams:  # streams[0] is read and streams[1] is write
#         async with ClientSession(streams[0], streams[1]) as session:
#             await session.initialize()
#             print("SSE connection is established")
#             tools = await session.list_tools()
#             for tool in tools.tools:
#                 print(tool)
#                 print("--------------------------------")
#             # # Call the list_dir tool
#             # result = await session.call_tool(
#             #     "list_dir",
#             #     {
#             #         "dir_path": "/Users/krishgoyani/Developer/TESTING",
#             #         "explanation": "Exploring the project directory structure",
#             #         "workspace_path": "/Users/krishgoyani/Developer/TESTING",
#             #     },
#             # )
#             # print(result)


# if __name__ == "__main__":
#     asyncio.run(main())
import json

text = """{"query":"hello","workspace_path":"/Users/krishgoyani/Developer/TESTING","hashed_workspace_path":"e16192bc5127ecb1af9b0afdd14662f4bf2531c6","git_branch":"main","system_info":{"platform":"darwin","osVersion":"24.5.0","architecture":"arm64","workspacePath":"/Users/krishgoyani/Developer/TESTING","defaultShell":"/bin/zsh"},"active_file_context":{"file":{"path":"/Users/krishgoyani/Developer/TESTING/DB/db.py","languageId":"python","lineCount":500,"fileSize":17545,"lastModified":"2025-06-10T13:38:45.143Z"},"cursor":{"line":319,"character":27,"selection":[{"line":318,"character":26},{"line":322,"character":39}],"lineContent":{"current":"                    while retry_count < max_retries:","above":"                    max_retries = 30","below":"                        status = ("},"selectedContent":"                    while retry_count < max_retries:\n                        status = (\n                            self.pc.describe_index(index_name)\n                            .get(\"status\")\n                            .get(\"state\")"},"viewport":{"visibleRanges":[[{"line":310,"character":0},{"line":330,"character":40}]],"startLine":310,"endLine":330}},"open_files_context":[{"path":"/Users/krishgoyani/Developer/TESTING/DB/db.py","languageId":"python","lineCount":500,"fileSize":17545,"lastModified":"2025-06-10T13:38:45.143Z"}],"recent_edits_context":{"summary":{"hasChanges":false,"timeWindow":"last 3 minutes","totalFiles":0,"checkInterval":180000},"modifiedFiles":[],"addedFiles":[],"deletedFiles":[],"timestamp":1749648286777,"gitBranch":"main","workspaceHash":"1749648250523-kuzw5fpc0"},"context_mentions":null}"""


print(json.dumps(text))
