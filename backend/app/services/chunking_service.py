import hashlib
import json
import os

from fastapi import Depends, HTTPException, status

from backend.app.config.settings import settings
from backend.app.models.domain.error import Error
from backend.app.repositories.error_repo import ErrorRepo
from backend.app.utils.logging_util import loggers


class ChunkingService:
    def __init__(self, error_repo: ErrorRepo = Depends(ErrorRepo)):
        self.error_repo = error_repo

        # MERN stack file extensions
        self.mern_extensions = [
            ".js",
            ".jsx",
            ".ts",
            ".tsx",  # JavaScript/TypeScript
            ".json",
            ".html",
            ".css",
            ".scss",  # Web assets
            ".md",
            ".env",
            ".gitignore",  # Config files
        ]

    def heuristic_chunking(self, file_path, token_limit=None, overlap=None):
        """
        Chunk a file based on token count with overlap.
        Used for all MERN stack files with a sliding window approach.
        """
        # Use settings values if not provided
        token_limit = token_limit or settings.CHUNK_TOKEN_LIMIT
        overlap = overlap or settings.CHUNK_OVERLAP

        try:
            with open(file_path, "r", encoding="utf-8") as file:
                content = file.read()

            # Split content by whitespace to count tokens approximately
            tokens = content.split()
            total_tokens = len(tokens)

            chunks = []
            line_mapping = {}

            # Create a mapping of token index to line number
            lines = content.split("\n")
            current_token_idx = 0
            for line_idx, line in enumerate(lines):
                line_tokens = len(line.split())
                for i in range(line_tokens):
                    line_mapping[current_token_idx + i] = line_idx
                current_token_idx += line_tokens

            # Create chunks with overlap
            for start_idx in range(0, total_tokens, token_limit - overlap):
                end_idx = min(start_idx + token_limit, total_tokens)

                # Get corresponding code
                chunk_tokens = tokens[start_idx:end_idx]
                chunk_code = " ".join(chunk_tokens)

                # Determine start and end lines
                start_line = line_mapping.get(start_idx, 0) + 1
                end_line = line_mapping.get(end_idx - 1, len(lines) - 1) + 1

                # Determine file type
                file_ext = os.path.splitext(file_path)[1].lower()
                file_type = file_ext[1:] if file_ext else "unknown"

                chunks.append(
                    {
                        "code": chunk_code,
                        "metadata": {
                            "file_path": file_path,
                            "file_type": file_type,
                            "start_line": start_line,
                            "end_line": end_line,
                            "start_token": start_idx,
                            "end_token": end_idx,
                            "total_tokens": total_tokens,
                        },
                    }
                )

                # Break if we've reached the end
                if end_idx >= total_tokens:
                    break

            return chunks
        except Exception as e:
            loggers["ChunkLogger"].error(
                f"Error in chunking for {file_path}: {str(e)}"
            )
            return []

    def chunk_codebase(self, file_path):
        """Chunk a single file from the MERN codebase"""
        try:
            # Check if it's a file type we should process
            _, file_extension = os.path.splitext(file_path)
            file_extension = file_extension.lower()

            if file_extension not in self.mern_extensions:
                loggers["ChunkLogger"].info(
                    f"Skipping non-MERN file: {file_path}"
                )
                return []

            # Use chunking with settings values
            chunks = self.heuristic_chunking(file_path)
            return chunks

        except Exception as e:
            loggers["ChunkLogger"].error(
                f"Error processing file {file_path}: {str(e)}"
            )
            return []

    def save_chunks_to_json(self, chunks, output_file="chunks.json"):
        """
        Saves the formatted chunks to a JSON file.

        Parameters:
            chunks (list): List of formatted chunk dictionaries.
            output_file (str): Path to the output JSON file.
        """
        try:
            # Ensure we have valid JSON content to write
            if not chunks:
                loggers["ChunkLogger"].warning(
                    f"No chunks to save to {output_file}"
                )
                chunks = []  # Ensure we at least write an empty array, not null

            # Write with explicit flush and close operations
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(chunks, f, indent=4)
                f.flush()
                os.fsync(f.fileno())  # Force write to disk
            print(f"Chunks saved to {output_file}")

            # Verify the file exists and has content
            file_size = os.path.getsize(output_file)
            loggers["ChunkLogger"].info(
                f"Chunks saved to {output_file} (size: {file_size} bytes)"
            )

            if file_size == 0:
                loggers["ChunkLogger"].warning(
                    f"Warning: {output_file} has zero size"
                )

            return True
        except Exception as e:
            loggers["ChunkLogger"].error(
                f"Error saving chunks to {output_file}: {str(e)}"
            )
            return False

    def format_chunks_for_json(self, chunks):
        """Format chunks for JSON output with additional MERN metadata"""
        formatted_chunks = []

        for chunk in chunks:
            code = chunk["code"]
            metadata = chunk["metadata"]
            file_path = metadata["file_path"]
            file_name = os.path.basename(file_path)

            # Extract just the directory name, not the full path
            full_directory = os.path.dirname(file_path)
            directory_name = (
                os.path.basename(full_directory) if full_directory else ""
            )

            # Get file extension/type
            _, file_extension = os.path.splitext(file_path)
            file_type = file_extension[1:] if file_extension else "unknown"

            # Determine component type based on path or extension
            component_type = "unknown"
            if "components" in file_path:
                component_type = "component"
            elif "routes" in file_path or "pages" in file_path:
                component_type = "page"
            elif "api" in file_path:
                component_type = "api"
            elif "models" in file_path:
                component_type = "model"
            elif "controllers" in file_path:
                component_type = "controller"
            elif "hooks" in file_path:
                component_type = "hook"

            # Count tokens
            token_count = len(code.split())

            formatted_chunk = {
                "id": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                "file_path": file_path,
                "file_name": file_name,
                "file_type": file_type,
                "directory": directory_name,
                "component_type": component_type,
                "start_line": metadata["start_line"],
                "end_line": metadata["end_line"],
                "content": code,
                "size": len(code),
                "token_count": token_count,
                "start_token": metadata.get("start_token"),
                "end_token": metadata.get("end_token"),
            }

            formatted_chunks.append(formatted_chunk)

        return formatted_chunks

    async def process_directory(self, directory_path, output_dir=None):
        # Use settings value if not provided
        output_dir = output_dir or settings.CHUNKS_OUTPUT_PATH

        try:
            all_chunks = []

            # Use ignore directories and files from settings
            ignore_directories = settings.IGNORE_DIRECTORIES
            ignore_files = settings.IGNORE_FILES

            # Create output directory if it doesn't exist
            if not os.path.exists(output_dir):
                os.makedirs(output_dir)

            loggers["ChunkLogger"].info(
                f"Scanning MERN codebase in directory: {directory_path}"
            )
            loggers["ChunkLogger"].info(
                f"Ignoring directories: {', '.join(ignore_directories)}"
            )
            loggers["ChunkLogger"].info(
                f"Ignoring files: {', '.join(ignore_files)}"
            )
            loggers["ChunkLogger"].info(
                f"Processing files with extensions: {', '.join(self.mern_extensions)}"
            )

            for root, dirs, files in os.walk(directory_path):
                # Modify dirs in-place to skip ignored directories
                dirs[:] = [d for d in dirs if d not in ignore_directories]

                for file in files:
                    # Skip files in the ignore list
                    if file.lower() in [f.lower() for f in ignore_files]:
                        loggers["ChunkLogger"].info(
                            f"Skipping ignored file: {file}"
                        )
                        continue

                    _, file_extension = os.path.splitext(file)
                    file_extension = file_extension.lower()

                    if file_extension in self.mern_extensions:
                        file_path = os.path.join(root, file)
                        loggers["ChunkLogger"].info(f"Processing: {file_path}")
                        file_chunks = self.chunk_codebase(file_path)

                        if file_chunks:
                            loggers["ChunkLogger"].info(
                                f"Found {len(file_chunks)} chunks in {file_path}"
                            )
                            all_chunks.extend(file_chunks)
                        else:
                            loggers["ChunkLogger"].warning(
                                f"No chunks extracted from {file_path}"
                            )

            # ... rest of the method unchanged

            total_chunks = len(all_chunks)
            loggers["ChunkLogger"].info(
                f"Total chunks extracted: {total_chunks}"
            )

            if not all_chunks:
                loggers["ChunkLogger"].warning("No chunks found in any files")
                # Save empty array to avoid null
                output_file = os.path.join(
                    output_dir, settings.CHUNKS_OUTPUT_FILENAME
                )
                self.save_chunks_to_json([], output_file)
                return {
                    "status": "warning",
                    "message": "No code chunks extracted",
                    "chunks_count": 0,
                    "output_file": output_file,
                }

            formatted_chunks = self.format_chunks_for_json(all_chunks)
            output_file = os.path.join(
                output_dir, settings.CHUNKS_OUTPUT_FILENAME
            )
            self.save_chunks_to_json(formatted_chunks, output_file)

            return {
                "status": "success",
                "chunks_count": len(formatted_chunks),
                "files_processed": len(
                    set(chunk["metadata"]["file_path"] for chunk in all_chunks)
                ),
                "output_file": output_file,
            }

        except Exception as e:
            error_message = (
                f"Error processing directory {directory_path}: {str(e)}"
            )
            loggers["ChunkLogger"].error(error_message)
            import traceback

            loggers["ChunkLogger"].error(traceback.format_exc())
            await self.error_repo.insert_error(
                Error(
                    tool_name="mern_codebase_chunking",
                    error_message=error_message,
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error_message,
            )
