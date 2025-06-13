import asyncio

from mcp.client.session import ClientSession
from mcp.client.sse import sse_client


async def main():
    async with sse_client(
        "http://localhost:8001/sse"
    ) as streams:  # streams[0] is read and streams[1] is write
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            result = await session.list_tools()
            # # Call the list_dir tool
            # result = await session.call_tool(
            #     "run_terminal_command",
            #     {
            #         "command": "ls -la",
            #         "explanation": "Adds a method to list all products currently stored in the database.",
            #         "workspace_path": "/Users/krishgoyani/Developer/health_app",
            #     },
            # )

            print(result)


if __name__ == "__main__":
    asyncio.run(main())
