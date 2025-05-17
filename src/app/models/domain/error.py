from datetime import datetime


class Error:
    def __init__(self, tool_name: str, error_message: str):
        self.tool_name: str = tool_name
        self.error_message: str = error_message
        self.timestamp: str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def to_dict(self):
        return {
            "tool_name": self.tool_name,
            "error_message": self.error_message,
            "timestamp": self.timestamp,
        }
