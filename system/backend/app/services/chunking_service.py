import hashlib
import json
import os

from fastapi import Depends, HTTPException, status

from system.backend.app.config.settings import settings
from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.utils.logging_util import loggers


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

        # Ensure token_limit and overlap are valid
        token_limit = max(100, int(token_limit)) if token_limit else 500
        overlap = min(
            int(overlap or 0), token_limit // 2
        )  # Default to 0 if None, and cap at half token_limit

        try:
            with open(file_path, "r", encoding="utf-8") as file:
                content = file.read()

            # If file is empty, return no chunks
            if not content.strip():
                return []

            # Split content by whitespace to count tokens approximately
            tokens = content.split()
            total_tokens = len(tokens)

            if total_tokens == 0:
                return []

            # If file is smaller than token limit, create a single chunk
            if total_tokens <= token_limit:
                # Return the whole file as one chunk
                return [
                    {
                        "code": content,
                        "metadata": {
                            "file_path": file_path,
                            "file_type": os.path.splitext(file_path)[1][
                                1:
                            ].lower()
                            or "unknown",
                            "start_line": 1,
                            "end_line": len(content.split("\n")),
                            "start_token": 0,
                            "end_token": total_tokens,
                            "total_tokens": total_tokens,
                        },
                    }
                ]

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
            # If no overlap, use stride equal to token_limit
            stride = token_limit - overlap if overlap > 0 else token_limit

            for start_idx in range(0, total_tokens, stride):
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

            print(f"Created {len(chunks)} chunks for {file_path}")
            return chunks

        except Exception as e:
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

            # Debug information
            print(f"Saving {len(chunks)} chunks to {output_file}")

            # Ensure output directory exists
            output_dir = os.path.dirname(output_file)
            if output_dir and not os.path.exists(output_dir):
                os.makedirs(output_dir)
                print(f"Created output directory: {output_dir}")

            # Ensure we have valid JSON content to write
            if not chunks:
                loggers["ChunkLogger"].warning(
                    f"No chunks to save to {output_file}"
                )
                chunks = []  # Ensure we at least write an empty array, not null
            try:
                json_content = json.dumps(chunks, indent=4)
            except Exception as json_err:
                # Try to identify problematic chunks
                for i, chunk in enumerate(chunks):
                    try:
                        json.dumps(chunk)
                    except Exception:
                        print(f"Problem with chunk {i}")
                        print(f"Chunk data: {str(chunk)[:200]}...")
                raise

            # Write with explicit flush and close operations
            with open(output_file, "w", encoding="utf-8") as f:
                f.write(json_content)
                f.flush()
                os.fsync(f.fileno())

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

        print(f"Formatting {len(chunks)} chunks for JSON")

        try:
            for i, chunk in enumerate(chunks):
                try:
                    code = chunk["code"]
                    metadata = chunk["metadata"]
                    file_path = metadata["file_path"]
                    file_name = os.path.basename(file_path)

                    # Extract directory info safely
                    full_directory = os.path.dirname(file_path)
                    directory_name = (
                        os.path.basename(full_directory)
                        if full_directory
                        else ""
                    )

                    # Get file extension
                    _, file_extension = os.path.splitext(file_path)
                    file_type = (
                        file_extension[1:] if file_extension else "unknown"
                    )

                    # Detect component type
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

                    # Limit content size to avoid potential issues with very large files
                    if len(code) > 1_000_000:  # 1MB limit
                        code = code[:1_000_000] + "... [content truncated]"

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

                    # Test JSON serialization before adding
                    json.dumps(formatted_chunk)

                    formatted_chunks.append(formatted_chunk)
                except Exception as chunk_err:
                    print(f"Error formatting chunk {i}: {str(chunk_err)}")
                    # Continue with other chunks

            return formatted_chunks

        except Exception as e:
            print(f"Error in format_chunks_for_json: {str(e)}")
            import traceback

            print(traceback.format_exc())
            # Return whatever chunks were successfully formatted
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

            total_chunks = len(all_chunks)
            loggers["ChunkLogger"].info(
                f"Total chunks extracted: {total_chunks}"
            )
            print(f"Total chunks extracted: {total_chunks}")

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
