import asyncio

from mcp.client.session import ClientSession
from mcp.client.sse import sse_client


async def main():
    async with sse_client(
        "http://localhost:8001/sse"
    ) as streams:  # streams[0] is read and streams[1] is write
        async with ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            # Call the list_dir tool
            result = await session.call_tool(
                "edit_file",
                {
                    "filePath": "/Users/krishgoyani/Developer/TESTING/main.py",
                    "codeSnippet": "def list_products(self):\n    self.cursor.execute('SELECT * FROM products')\n    return self.cursor.fetchall()",
                    "explanation": "Adds a method to list all products currently stored in the database.",
                },
            )

            print(result)


if __name__ == "__main__":
    asyncio.run(main())
