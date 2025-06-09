import asyncio
import json
import time
from datetime import datetime
from typing import AsyncGenerator, Optional

from dotenv import load_dotenv
from openai import OpenAI

from system.backend.app.config.settings import settings
from system.backend.app.prompts.file_modification_prompt import (
    FILE_MODIFICATION_PROMPT,
)


class ReapplyService:
    def __init__(self):
        self.HF_API_KEY = settings.HUGGINGFACE_API_KEY
        self.BASE_URL = settings.HUGGINGFACE_API_URL
        self.client = OpenAI(base_url=self.BASE_URL, api_key=self.HF_API_KEY)

    async def reapply(
        self,
        target_file_content: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ):
        try:
            try:
                edited_content = await self._apply_code_changes(
                    target_file_content, code_snippet
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
                        "target_file_content": target_file_content,
                        "timestamp": datetime.now().isoformat(),
                    },
                }

            return {
                "success": True,
                "details": {
                    "edited_content": edited_content,
                    "timestamp": datetime.now().isoformat(),
                },
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "details": {
                    "target_file_content": target_file_content,
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

    async def reapply_stream(
        self,
        target_file_content: str,
        code_snippet: str,
        explanation: str,
        workspace_path: str = None,
    ) -> AsyncGenerator[str, None]:
        """Stream the file reapplication process as server-sent events"""
        try:
            # Send model preparation event
            yield self._create_sse_event(
                "model_preparation",
                "Initializing model for code reapplication...",
                {
                    "model": "tgi_dummy_reapply",
                    "stage": "model_init",
                    "explanation": explanation,
                },
            )

            # Stream the actual reapplication process
            async for event in self._apply_code_changes_stream_dummy(
                target_file_content, code_snippet
            ):
                yield event

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Reapply service error: {str(e)}",
                {
                    "stage": "service",
                    "timestamp": datetime.now().isoformat(),
                },
            )

    async def _apply_code_changes_stream_dummy(
        self, original_code: str, code_snippet: str
    ) -> AsyncGenerator[str, None]:
        """
        Dummy implementation that simulates streaming code changes with fake Python code.
        Used for testing when the actual TGI model is unavailable.

        Args:
            original_code (str): The original code content
            code_snippet (str): The code snippet to apply

        Yields:
            str: Server-sent events for streaming
        """
        try:
            # Dummy Python code (~50 lines) - different from edit_file for variety
            dummy_code = '''import asyncio
import logging
import json
from typing import Dict, List, Optional, Union, Any
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum

# Setup logging configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class TaskStatus(Enum):
    """Enumeration for task statuses."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass
class Task:
    """Represents a task with scheduling and tracking capabilities."""
    task_id: str
    title: str
    description: str
    status: TaskStatus = TaskStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: Optional[datetime] = None
    due_date: Optional[datetime] = None
    priority: int = 1
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

class TaskScheduler:
    """Advanced task scheduler with persistence and monitoring."""
    
    def __init__(self, storage_path: str = "tasks.json"):
        self.tasks: Dict[str, Task] = {}
        self.storage_path = Path(storage_path)
        self.running_tasks: Dict[str, asyncio.Task] = {}
        
    async def create_task(self, title: str, description: str, 
                         due_date: Optional[datetime] = None, 
                         priority: int = 1, tags: List[str] = None) -> Task:
        """Create a new task and add it to the scheduler."""
        task_id = f"task_{len(self.tasks) + 1:06d}"
        
        task = Task(
            task_id=task_id,
            title=title,
            description=description,
            due_date=due_date,
            priority=priority,
            tags=tags or []
        )
        
        self.tasks[task_id] = task
        logger.info(f"Created task: {title} with ID: {task_id}")
        
        await self._persist_tasks()
        return task
    
    async def execute_task(self, task_id: str) -> bool:
        """Execute a specific task asynchronously."""
        if task_id not in self.tasks:
            logger.error(f"Task {task_id} not found")
            return False
            
        task = self.tasks[task_id]
        task.status = TaskStatus.IN_PROGRESS
        task.updated_at = datetime.now()
        
        try:
            # Simulate task execution
            await asyncio.sleep(2)
            task.status = TaskStatus.COMPLETED
            task.updated_at = datetime.now()
            logger.info(f"Task {task_id} completed successfully")
            return True
            
        except Exception as e:
            task.status = TaskStatus.FAILED
            task.updated_at = datetime.now()
            logger.error(f"Task {task_id} failed: {str(e)}")
            return False
    
    async def _persist_tasks(self) -> None:
        """Save tasks to persistent storage."""
        task_data = {
            task_id: {
                "title": task.title,
                "description": task.description,
                "status": task.status.value,
                "created_at": task.created_at.isoformat(),
                "updated_at": task.updated_at.isoformat() if task.updated_at else None,
                "due_date": task.due_date.isoformat() if task.due_date else None,
                "priority": task.priority,
                "tags": task.tags,
                "metadata": task.metadata
            }
            for task_id, task in self.tasks.items()
        }
        
        with open(self.storage_path, 'w') as f:
            json.dump(task_data, f, indent=2)'''

            # Simulate the full response with tags (using reapply-specific template)
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

            full_response = f"I'll merge the changes into your code as requested.\n\n<updated-code>\n{dummy_code}\n</updated-code>\n\nThe code has been successfully merged with proper structure preservation."

            # Send model request event
            yield self._create_sse_event(
                "model_request",
                "Sending request to reapply model...",
                {
                    "model": "tgi_dummy_reapply",
                    "max_tokens": 20000,
                    "prompt_length": len(TGI_USER_PROMPT_TEMPLATE),
                },
            )

            # Small delay to simulate network request
            await asyncio.sleep(0.1)

            # Send streaming start event
            yield self._create_sse_event(
                "model_streaming",
                "Receiving streamed response from reapply model...",
                {"status": "streaming_started"},
            )

            # Stream the response in chunks
            chunk_size = 50  # Characters per chunk
            chunk_count = 0
            inside_code_block = False
            code_content = ""

            for i in range(0, len(full_response), chunk_size):
                chunk = full_response[i : i + chunk_size]
                chunk_count += 1

                # Small delay to simulate streaming
                await asyncio.sleep(0.05)

                # Check if we're entering or inside the code block
                if "<updated-code>" in chunk and not inside_code_block:
                    inside_code_block = True
                    yield self._create_sse_event(
                        "code_generation_start",
                        "Started generating reapplied code...",
                        {"chunk_count": chunk_count},
                    )
                    # Extract any code content after the tag
                    start_pos = chunk.find("<updated-code>") + len(
                        "<updated-code>"
                    )
                    if start_pos < len(chunk):
                        code_chunk = chunk[start_pos:]
                        if code_chunk.strip():
                            code_content += code_chunk
                            yield self._create_sse_event(
                                "code_chunk",
                                code_chunk,
                                {
                                    "chunk_number": chunk_count,
                                    "total_code_length": len(code_content),
                                    "is_inside_code_block": True,
                                },
                            )
                elif inside_code_block and "</updated-code>" not in chunk:
                    # We're inside the code block, stream the content
                    code_content += chunk
                    yield self._create_sse_event(
                        "code_chunk",
                        chunk,
                        {
                            "chunk_number": chunk_count,
                            "total_code_length": len(code_content),
                            "is_inside_code_block": True,
                        },
                    )
                elif inside_code_block and "</updated-code>" in chunk:
                    # We're reaching the end of the code block
                    end_pos = chunk.find("</updated-code>")
                    if end_pos > 0:
                        final_chunk = chunk[:end_pos]
                        code_content += final_chunk
                        yield self._create_sse_event(
                            "code_chunk",
                            final_chunk,
                            {
                                "chunk_number": chunk_count,
                                "total_code_length": len(code_content),
                                "is_inside_code_block": True,
                            },
                        )

                    inside_code_block = False
                    yield self._create_sse_event(
                        "code_generation_complete",
                        "Code reapplication completed",
                        {
                            "total_chunks": chunk_count,
                            "final_code_length": len(code_content),
                        },
                    )
                else:
                    # Stream non-code content for debugging/context
                    yield self._create_sse_event(
                        "model_output",
                        chunk,
                        {
                            "chunk_number": chunk_count,
                            "is_inside_code_block": False,
                        },
                    )

        except Exception as e:
            yield self._create_sse_event(
                "error",
                f"Dummy reapply streaming error: {str(e)}",
                {
                    "stage": "dummy_model_streaming",
                    "timestamp": datetime.now().isoformat(),
                },
            )

    async def _get_dummy_edited_content(
        self, original_code: str, code_snippet: str
    ) -> Optional[str]:
        """Get the final edited content from dummy implementation"""
        try:
            # Return the same dummy code that was streamed
            dummy_code = '''import asyncio
import logging
import json
from typing import Dict, List, Optional, Union, Any
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum

# Setup logging configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class TaskStatus(Enum):
    """Enumeration for task statuses."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass
class Task:
    """Represents a task with scheduling and tracking capabilities."""
    task_id: str
    title: str
    description: str
    status: TaskStatus = TaskStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: Optional[datetime] = None
    due_date: Optional[datetime] = None
    priority: int = 1
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

class TaskScheduler:
    """Advanced task scheduler with persistence and monitoring."""
    
    def __init__(self, storage_path: str = "tasks.json"):
        self.tasks: Dict[str, Task] = {}
        self.storage_path = Path(storage_path)
        self.running_tasks: Dict[str, asyncio.Task] = {}
        
    async def create_task(self, title: str, description: str, 
                         due_date: Optional[datetime] = None, 
                         priority: int = 1, tags: List[str] = None) -> Task:
        """Create a new task and add it to the scheduler."""
        task_id = f"task_{len(self.tasks) + 1:06d}"
        
        task = Task(
            task_id=task_id,
            title=title,
            description=description,
            due_date=due_date,
            priority=priority,
            tags=tags or []
        )
        
        self.tasks[task_id] = task
        logger.info(f"Created task: {title} with ID: {task_id}")
        
        await self._persist_tasks()
        return task
    
    async def execute_task(self, task_id: str) -> bool:
        """Execute a specific task asynchronously."""
        if task_id not in self.tasks:
            logger.error(f"Task {task_id} not found")
            return False
            
        task = self.tasks[task_id]
        task.status = TaskStatus.IN_PROGRESS
        task.updated_at = datetime.now()
        
        try:
            # Simulate task execution
            await asyncio.sleep(2)
            task.status = TaskStatus.COMPLETED
            task.updated_at = datetime.now()
            logger.info(f"Task {task_id} completed successfully")
            return True
            
        except Exception as e:
            task.status = TaskStatus.FAILED
            task.updated_at = datetime.now()
            logger.error(f"Task {task_id} failed: {str(e)}")
            return False
    
    async def _persist_tasks(self) -> None:
        """Save tasks to persistent storage."""
        task_data = {
            task_id: {
                "title": task.title,
                "description": task.description,
                "status": task.status.value,
                "created_at": task.created_at.isoformat(),
                "updated_at": task.updated_at.isoformat() if task.updated_at else None,
                "due_date": task.due_date.isoformat() if task.due_date else None,
                "priority": task.priority,
                "tags": task.tags,
                "metadata": task.metadata
            }
            for task_id, task in self.tasks.items()
        }
        
        with open(self.storage_path, 'w') as f:
            json.dump(task_data, f, indent=2)'''

            return dummy_code
        except Exception as e:
            print(f"Dummy content generation error: {str(e)}")
            return None

    def _create_sse_event(
        self, event_type: str, content: str, metadata: dict = None
    ) -> str:
        """Create a server-sent event formatted string"""
        event_data = {
            "type": event_type,
            "content": content,
            "metadata": metadata or {},
            "timestamp": time.time(),
        }
        return f"data: {json.dumps(event_data)}\n\n"
