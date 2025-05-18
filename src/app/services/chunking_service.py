import tree_sitter_python as tspython
from tree_sitter import Language, Parser
import uuid
import json
import os
import hashlib
import re
import time
import httpx
from fastapi import Depends, HTTPException, status

from src.app.config.settings import settings
from src.app.utils.codebase_context_utils import codebase_context
from src.app.utils.logging_util import loggers
from datetime import datetime, timedelta
from src.app.models.domain.error import Error
from src.app.repositories.error_repo import ErrorRepo


class ChunkingService:
    def __init__(self, error_repo: ErrorRepo = Depends(ErrorRepo)):
        self.error_repo = error_repo
        self.PY_LANGUAGE = Language(tspython.language())
        self.parser = Parser(self.PY_LANGUAGE)
        
    def extract_chunks(self, node, code_bytes, file_path, current_class=None, import_statements=None):
        if import_statements is None:
            import_statements = []

        chunks = []

        if node.type in ['import_statement', 'import_from_statement']:
            start = node.start_byte
            end = node.end_byte
            import_statements.append(code_bytes[start:end])
        elif node.type == 'class_definition':
            class_name_node = node.child_by_field_name('name')
            if class_name_node:
                current_class = code_bytes[class_name_node.start_byte:class_name_node.end_byte]
            for child in node.children:
                chunks.extend(self.extract_chunks(child, code_bytes, file_path, current_class, import_statements))
        elif node.type == 'function_definition':
            start = node.start_byte
            end = node.end_byte
            function_code = code_bytes[start:end]
            
            function_name_node = node.child_by_field_name('name')
            function_name = None
            if function_name_node:
                function_name = code_bytes[function_name_node.start_byte:function_name_node.end_byte]
            
            start_line = node.start_point[0] + 1  
            end_line = node.end_point[0] + 1  

            chunks.append({
                'code': function_code,
                'metadata': {
                    'class': current_class,
                    'function_name': function_name,
                    'file_path': file_path,
                    'start_line': start_line,
                    'end_line': end_line
                }
            })
        else:
            for child in node.children:
                chunks.extend(self.extract_chunks(child, code_bytes, file_path, current_class, import_statements))

        if node.type == 'module' and import_statements:
            combined_imports = '\n'.join(import_statements)
            start_line = node.start_point[0] + 1 
            end_line = start_line + len(import_statements) - 1

            chunks.insert(0, {
                'code': combined_imports,
                'metadata': {
                    'class': None,
                    'function_name': None,
                    'file_path': file_path,
                    'start_line': start_line,
                    'end_line': end_line
                }
            })

        return chunks

    def chunk_codebase(self, file_path):
        try:
            tree = self.parse_code(file_path)
            root_node = tree.root_node
            
            with open(file_path, 'r', encoding='utf-8') as file:
                code_bytes = file.read()
            
            chunks = self.extract_chunks(root_node, code_bytes, file_path=file_path)
            return chunks
        except Exception as e:
            loggers["ChunkLogger"].error(f"Error processing file {file_path}: {str(e)}")
            return []
        
    def save_chunks_to_json(self,chunks, output_file="chunks.json"):
        """
        Saves the formatted chunks to a JSON file.
        
        Parameters:
            chunks (list): List of formatted chunk dictionaries.
            output_file (str): Path to the output JSON file.
        """
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(chunks, f, indent=4)
        
        print(f"Chunks saved to {output_file}")

    def split_large_chunk(self, chunk, max_token_limit):
        """Split a large chunk into smaller chunks that fit within token limit"""
        code = chunk['code']
        metadata = chunk['metadata']
        
        # Simple splitting by lines
        lines = code.split('\n')
        current_chunk_lines = []
        current_token_count = 0
        split_chunks = []
        chunk_index = 1
        
        for line in lines:
            line_token_count = len(line.split())
            if current_token_count + line_token_count > max_token_limit:
                if current_chunk_lines:
                    split_code = '\n'.join(current_chunk_lines)
                    # Create new metadata with updated line numbers
                    new_metadata = metadata.copy()
                    new_metadata['start_line'] = metadata['start_line'] + (chunk_index - 1) * len(current_chunk_lines)
                    new_metadata['end_line'] = new_metadata['start_line'] + len(current_chunk_lines) - 1
                    new_metadata['chunk_index'] = chunk_index
                    new_metadata['is_split'] = True
                    
                    split_chunks.append({
                        'code': split_code,
                        'metadata': new_metadata
                    })
                    
                    current_chunk_lines = [line]
                    current_token_count = line_token_count
                    chunk_index += 1
                else:
                    # A single line exceeds token limit, we'll include it anyway
                    split_chunks.append({
                        'code': line,
                        'metadata': {
                            'class': metadata['class'],
                            'function_name': metadata['function_name'],
                            'file_path': metadata['file_path'],
                            'start_line': metadata['start_line'],
                            'end_line': metadata['start_line'],
                            'chunk_index': chunk_index,
                            'is_split': True
                        }
                    })
                    chunk_index += 1
            else:
                current_chunk_lines.append(line)
                current_token_count += line_token_count
        
        # Add the last chunk if there's anything left
        if current_chunk_lines:
            split_code = '\n'.join(current_chunk_lines)
            new_metadata = metadata.copy()
            new_metadata['start_line'] = metadata['start_line'] + (chunk_index - 1) * len(current_chunk_lines)
            new_metadata['end_line'] = new_metadata['start_line'] + len(current_chunk_lines) - 1
            new_metadata['chunk_index'] = chunk_index
            new_metadata['is_split'] = True
            
            split_chunks.append({
                'code': split_code,
                'metadata': new_metadata
            })
        
        return split_chunks

    def format_chunks_for_json(self, chunks, max_token_limit=32000):
        formatted_chunks = []
        for chunk in chunks:
            code = chunk['code']
            
            # Approximate token count (simple whitespace-based approach)
            token_count = len(code.split())
            
            # If token count exceeds limit, split the chunk
            if token_count > max_token_limit:
                loggers["ChunkLogger"].warning(f"Chunk exceeds token limit ({token_count} > {max_token_limit}), splitting into smaller chunks")
                split_chunks = self.split_large_chunk(chunk, max_token_limit)
                
                # Process each split chunk
                for split_chunk in split_chunks:
                    formatted_chunks.append(self.format_single_chunk(split_chunk, max_token_limit))
            else:
                formatted_chunks.append(self.format_single_chunk(chunk, max_token_limit))
                
        return formatted_chunks

    def format_single_chunk(self, chunk, max_token_limit):
        """Format a single chunk for JSON output"""
        code = chunk['code']
        token_count = len(code.split())
        metadata = chunk['metadata']
        file_path = metadata['file_path']
        file_name = os.path.basename(file_path)
        
        # Extract just the directory name, not the full path
        full_directory = os.path.dirname(file_path)
        directory_name = os.path.basename(full_directory) if full_directory else ""
        
        # Include split information if present
        chunk_index = metadata.get('chunk_index', 1)
        is_split = metadata.get('is_split', False)
        
        formatted_chunk = {
            "id": hashlib.sha256((code + str(chunk_index)).encode('utf-8')).hexdigest(),
            "file_path": file_path,
            "file_name": file_name,
            "directory": directory_name,
            "start_line": metadata['start_line'],
            "end_line": metadata['end_line'],
            "content": code,
            "size": len(code),
            "token_count": token_count,
            "parent-class": metadata['class'],
            "function_name": metadata['function_name'],
            "is_split": is_split,
            "chunk_index": chunk_index if is_split else 1
        }
        return formatted_chunk

    async def process_directory(self, directory_path, output_dir="chunks", max_token_limit=32000):
        try:
            all_chunks = []
            
            # Create output directory if it doesn't exist
            if not os.path.exists(output_dir):
                os.makedirs(output_dir)
                
            for root, _, files in os.walk(directory_path):
                for file in files:
                    if file.endswith(".py"):
                        file_path = os.path.join(root, file)
                        loggers["ChunkLogger"].info(f"Processing: {file_path}")
                        file_chunks = self.chunk_codebase(file_path)
                        
                        for chunk in file_chunks:
                            code = chunk['code']
                            metadata = chunk['metadata']
                            loggers["ChunkLogger"].info(f"File: {metadata['file_path']}")
                            loggers["ChunkLogger"].info(f"Class: {metadata['class']}")
                            loggers["ChunkLogger"].info(f"Lines: {metadata['start_line']} to {metadata['end_line']}")
                            
                        all_chunks.extend(file_chunks)
                        
            formatted_chunks = self.format_chunks_for_json(all_chunks, max_token_limit)
            output_file = os.path.join(output_dir, "codebase_chunks.json")
            self.save_chunks_to_json(formatted_chunks, output_file)
            
            # Count original and split chunks
            original_count = len(all_chunks)
            split_count = len(formatted_chunks)
            
            return {
                "status": "success",
                "original_chunks_count": original_count,
                "formatted_chunks_count": split_count,
                "chunks_split": split_count > original_count,
                "output_file": output_file
            }
            
        except Exception as e:
            error_message = f"Error processing directory {directory_path}: {str(e)}"
            loggers["ChunkLogger"].error(error_message)
            await self.error_repo.insert_error(
                Error(
                    tool_name="codebase_chunking",
                    error_message=error_message,
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error_message,
            )