import asyncio

from mcp.client.session import ClientSession
from mcp.client.sse import sse_client


async def main():
    async with sse_client(
        "http://localhost:8001/sse"
    ) as streams:  # streams[0] is read and streams[1] is write
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            print("SSE connection is established")
            tools = await session.list_tools()
            print(f"Available tools: {tools}")

            # # Call the list_dir tool
            # result = await session.call_tool(
            #     "list_dir",
            #     {
            #         "dir_path": "/Users/krishgoyani/Developer/TESTING",
            #         "explanation": "Exploring the project directory structure",
            #         "workspace_path": "/Users/krishgoyani/Developer/TESTING",
            #     },
            # )
            # print(result)


if __name__ == "__main__":
    asyncio.run(main())
