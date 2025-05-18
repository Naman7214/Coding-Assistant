import os
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from openai import OpenAI

from backend.app.config.settings import settings


class EditFileService:
    def __init__(self):
        self.HF_API_KEY = settings.HUGGINGFACE_API_KEY
        self.BASE_URL = settings.HUGGINGFACE_API_URL
        self.client = OpenAI(base_url=self.BASE_URL, api_key=self.HF_API_KEY)

    async def edit_file(
        self, target_file_path: str, code_snippet: str, explanation: str
    ):
        try:
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

            TGI_USER_PROMPT_TEMPLATE = f"""<|im_start|>system
                You are a coding assistant that helps merge code updates, ensuring every modification is fully integrated.<|im_end|>
                <|im_start|>user
                Merge all changes from the <update> snippet into the <code> below.
                - Preserve the code's structure, order, comments, and indentation exactly.
                - Output only the updated code, enclosed within <updated-code> and </updated-code> tags.
                - Do not include any additional text, explanations, placeholders, ellipses, or code fences.

                <code>{original_code}</code>

                <update>{code_snippet}</update>

                Provide the complete updated code.<|im_end|>
                <|im_start|>assistant
            """

            user_query = TGI_USER_PROMPT_TEMPLATE

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
