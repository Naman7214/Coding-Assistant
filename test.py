import asyncio

from mcp.client.session import ClientSession
from mcp.client.sse import sse_client


async def main():
    async with sse_client(
        "http://localhost:8001/sse"
    ) as streams:  # streams[0] is read and streams[1] is write we can also do as (read, write)
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            print("sse connection is made")
            tools = await session.list_tools()

            # Call the fetch tool
            result = await session.call_tool(
                "delete_file",
                {
                    "explanation": "string",
                    "workspace_path": "/Users/krishgoyani/Developer/TESTING",
                    "path": "/Users/krishgoyani/Developer/TESTING/main.py",
                },
            )
            print(result)


asyncio.run(main())
