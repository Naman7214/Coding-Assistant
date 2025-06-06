import os
from datetime import datetime
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException, status
from openai import OpenAI

from system.backend.app.config.settings import settings
from system.backend.app.models.domain.error import Error
from system.backend.app.prompts.file_modification_prompt import (
    FILE_MODIFICATION_PROMPT,
)
from system.backend.app.utils.path_validator import is_safe_path


class EditFileService:
    def __init__(self):
        self.HF_API_KEY = settings.HUGGINGFACE_API_KEY
        self.BASE_URL = settings.HUGGINGFACE_API_URL
        self.http_client = httpx.Client(verify=False)
        self.client = OpenAI(
            base_url=self.BASE_URL,
            api_key=self.HF_API_KEY,
            http_client=self.http_client,
        )

    async def edit_file(
        self, target_file_path: str, code_snippet: str, explanation: str
    ):
        try:

            is_safe, error_msg = is_safe_path(target_file_path)
            if not is_safe:
                await self.error_repo.insert_error(
                    Error(
                        tool_name="EditFileService",
                        error_message=f"Access denied: {error_msg}",
                        timestamp=datetime.now().isoformat(),
                    )
                )
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Access denied: {error_msg}",
                )

            if not os.path.exists(target_file_path):
                return {
                    "success": False,
                    "error": "Target file does not exist",
                    "details": {
                        "file_path": target_file_path,
                        "timestamp": datetime.now().isoformat(),
                    },
                }

            with open(target_file_path, "r", encoding="utf-8") as file:
                original_content = file.read()

            try:
                edited_content = await self._apply_code_changes(
                    original_content, code_snippet
                )

                if edited_content is None:
                    raise ValueError("Failed to apply code changes")

                if not isinstance(edited_content, str):
                    raise ValueError("Edited content must be a string")

                if not edited_content:
                    raise ValueError("Edited content cannot be empty")

            except Exception as api_error:
                return {
                    "success": False,
                    "error": f"FastApply model API error: {str(api_error)}",
                    "details": {
                        "file_path": target_file_path,
                        "timestamp": datetime.now().isoformat(),
                    },
                }

            # Write the complete edited content to file
            with open(target_file_path, "w", encoding="utf-8") as file:
                file.write(edited_content)

            return {
                "success": True,
                "details": {
                    "file_path": target_file_path,
                    "original_size": len(original_content),
                    "new_size": len(edited_content),
                    "timestamp": datetime.now().isoformat(),
                },
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "details": {
                    "file_path": target_file_path,
                    "timestamp": datetime.now().isoformat(),
                },
            }

    async def _apply_code_changes(
        self, original_code: str, code_snippet: str
    ) -> Optional[str]:
        """
        Apply code changes to the original code using the TGI model.

        Args:
            original_code (str): The original code content
            code_snippet (str): The code snippet to apply

        Returns:
            Optional[str]: The updated code content, or None if failed
        """
        try:
            load_dotenv()

            user_query = FILE_MODIFICATION_PROMPT.format(
                original_code=original_code, code_snippet=code_snippet
            )

            chat_completion = self.client.chat.completions.create(
                model="tgi",
                messages=[{"role": "user", "content": user_query}],
                max_tokens=20000,
                stream=True,
            )

            edited_content = ""
            for message in chat_completion:
                content = message.choices[0].delta.content
                if content:
                    edited_content += content

            if (
                "<updated-code>" in edited_content
                and "</updated-code>" in edited_content
            ):
                start_tag = "<updated-code>"
                end_tag = "</updated-code>"
                start_pos = edited_content.find(start_tag) + len(start_tag)
                end_pos = edited_content.find(end_tag)
                edited_content = edited_content[start_pos:end_pos].strip()

            if not isinstance(edited_content, str):
                raise ValueError("Edited content must be a string")

            if not edited_content:
                raise ValueError("Edited content cannot be empty")

            return edited_content

        except Exception as e:
            print(f"FastApply error: {str(e)}")
            return None
