import json
import time
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta


class AgentMemory:
    def __init__(self, max_context_window=32000, max_tool_result_length=2000):
        # Configuration
        self.max_context_window = max_context_window
        self.max_tool_result_length = max_tool_result_length
        
        # Core conversation history
        self.system_message = None
        self.conversation_history = []  # Recent important messages
        self.compressed_history = []    # Summarized older messages
        
        # Tool tracking
        self.tool_calls_history = []
        self.tools_used_session = set()
        self.total_tool_calls = 0
        
        # Context management
        self.current_context_size = 0
        self.last_compression_time = time.time()
        self.compression_threshold = 20000  # Compress when context exceeds this
        
        # Session metadata
        self.session_start_time = time.time()
        self.important_context = []  # Key insights to preserve

    def initialize_with_system_message(self, system_message: str):
        """Initialize with system message"""
        self.system_message = {"role": "system", "content": system_message}
        self.current_context_size = len(system_message)

    def add_user_message(self, message: str):
        """Add user message with smart context management"""
        user_msg = {"role": "user", "content": [{"type": "text", "text": message}]}
        self.conversation_history.append(user_msg)
        self.current_context_size += len(message)
        self._check_and_compress()

    def add_assistant_message(self, message: Dict[str, Any]):
        """Add assistant message with content filtering"""
        # Extract and preserve only essential content
        filtered_message = self._filter_assistant_message(message)
        self.conversation_history.append(filtered_message)
        self.current_context_size += self._estimate_message_size(filtered_message)
        self._check_and_compress()

    def add_tool_call(self, tool_call: Dict[str, Any], result: str):
        """Record tool call with intelligent result summarization"""
        # Summarize large results
        summarized_result = self._summarize_tool_result(result, tool_call.get("name", ""))
        
        call_info = {
            "tool": tool_call.get("name", ""),
            "arguments": tool_call.get("input", {}),
            "result_summary": summarized_result,
            "timestamp": time.time(),
            "success": not result.startswith("ERROR:")
        }
        
        self.tool_calls_history.append(call_info)
        self.tools_used_session.add(tool_call.get("name", ""))
        self.total_tool_calls += 1

    def add_tool_result(self, tool_use_id: str, content: str):
        """Add tool result with smart truncation"""
        # Truncate large content but preserve key information
        processed_content = self._process_tool_result(content)
        
        tool_result_msg = {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": processed_content,
            }],
        }
        
        self.conversation_history.append(tool_result_msg)
        self.current_context_size += len(processed_content)
        self._check_and_compress()

    def get_conversation_messages(self) -> List[Dict[str, Any]]:
        """Get optimized conversation for API calls with proper tool_use/tool_result pairing"""
        messages = []
        
        # Always include system message
        if self.system_message:
            messages.append(self.system_message)
        
        # Include compressed history summary if exists (but not raw compressed messages)
        if self.compressed_history:
            summary = self._create_context_summary()
            if summary:
                messages.append({
                    "role": "user", 
                    "content": [{"type": "text", "text": f"Previous context summary: {summary}"}]
                })
        
        # Get recent conversation with proper tool pairing
        recent_messages = self._get_valid_recent_messages()
        messages.extend(recent_messages)
        
        # Add current tool usage context
        tool_summary = self.get_concise_tool_summary()
        if tool_summary and self.total_tool_calls > 0:
            messages.append({
                "role": "user",
                "content": [{"type": "text", "text": f"Current session tools: {tool_summary}"}]
            })
        
        return messages

    def _get_valid_recent_messages(self) -> List[Dict[str, Any]]:
        """Get recent messages ensuring tool_use/tool_result pairing is maintained"""
        if not self.conversation_history:
            return []
        
        # Start with all recent messages (last 12 to have room for tool pairs)
        recent_messages = self.conversation_history[-12:]
        valid_messages = []
        
        i = 0
        while i < len(recent_messages):
            current_msg = recent_messages[i]
            
            # If this is an assistant message with tool_use, ensure we include the tool_result
            if (current_msg.get("role") == "assistant" and 
                self._has_tool_use(current_msg)):
                
                # Add the assistant message with tool_use
                valid_messages.append(current_msg)
                
                # Look for the corresponding tool_result in the next message
                if i + 1 < len(recent_messages):
                    next_msg = recent_messages[i + 1]
                    if (next_msg.get("role") == "user" and 
                        self._has_tool_result(next_msg)):
                        # Verify the tool_result matches tool_use
                        if self._tool_results_match_tool_uses(current_msg, next_msg):
                            valid_messages.append(next_msg)
                            i += 2  # Skip both messages
                            continue
                
                # If no matching tool_result found, remove the tool_use from assistant message
                filtered_msg = self._remove_tool_use_from_message(current_msg)
                valid_messages[-1] = filtered_msg  # Replace with filtered version
                i += 1
                
            # If this is a tool_result without preceding tool_use, skip it
            elif (current_msg.get("role") == "user" and 
                  self._has_tool_result(current_msg)):
                # Check if previous message has matching tool_use
                if (valid_messages and 
                    valid_messages[-1].get("role") == "assistant" and
                    self._has_tool_use(valid_messages[-1]) and
                    self._tool_results_match_tool_uses(valid_messages[-1], current_msg)):
                    valid_messages.append(current_msg)
                # Otherwise skip this orphaned tool_result
                i += 1
                
            else:
                # Regular message, just add it
                valid_messages.append(current_msg)
                i += 1
        
        return valid_messages

    def _has_tool_use(self, message: Dict[str, Any]) -> bool:
        """Check if message contains tool_use blocks"""
        content = message.get("content", [])
        return any(block.get("type") == "tool_use" for block in content)

    def _has_tool_result(self, message: Dict[str, Any]) -> bool:
        """Check if message contains tool_result blocks"""
        content = message.get("content", [])
        return any(block.get("type") == "tool_result" for block in content)

    def _tool_results_match_tool_uses(self, tool_use_msg: Dict[str, Any], tool_result_msg: Dict[str, Any]) -> bool:
        """Check if tool_result IDs match tool_use IDs"""
        tool_use_ids = set()
        for block in tool_use_msg.get("content", []):
            if block.get("type") == "tool_use":
                tool_use_ids.add(block.get("id"))
        
        tool_result_ids = set()
        for block in tool_result_msg.get("content", []):
            if block.get("type") == "tool_result":
                tool_result_ids.add(block.get("tool_use_id"))
        
        # All tool_result IDs should match tool_use IDs
        return tool_result_ids.issubset(tool_use_ids)

    def _remove_tool_use_from_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Remove tool_use blocks from a message, keeping only text"""
        filtered_content = []
        for block in message.get("content", []):
            if block.get("type") == "text":
                filtered_content.append(block)
            # Skip tool_use blocks
        
        return {
            "role": message.get("role"),
            "content": filtered_content
        }

    def _filter_assistant_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """Filter assistant message to keep only essential content"""
        filtered_content = []
        
        for block in message.get("content", []):
            if block.get("type") == "text":
                # Keep text content but truncate if very long
                text = block.get("text", "")
                if len(text) > 1000:
                    text = text[:1000] + "...[truncated]"
                filtered_content.append({"type": "text", "text": text})
            
            elif block.get("type") == "tool_use":
                # Always keep tool use blocks
                filtered_content.append(block)
            
            elif block.get("type") == "thinking":
                # Skip thinking blocks to save space (already processed)
                continue
        
        return {"role": "assistant", "content": filtered_content}

    def _summarize_tool_result(self, result: str, tool_name: str) -> str:
        """Intelligently summarize tool results"""
        if len(result) <= self.max_tool_result_length:
            return result
        
        # Different summarization strategies based on tool type
        if tool_name in ["codebase_search", "grep_search"]:
            return self._summarize_search_result(result)
        elif tool_name == "read_file":
            return self._summarize_file_content(result)
        elif tool_name == "list_dir":
            return self._summarize_directory_listing(result)
        else:
            # Generic summarization
            return result[:self.max_tool_result_length] + f"...[truncated from {len(result)} chars]"

    def _summarize_search_result(self, result: str) -> str:
        """Summarize search results keeping key findings"""
        lines = result.split('\n')
        summary_lines = []
        
        # Keep first few results and statistics
        for i, line in enumerate(lines[:20]):  # First 20 lines
            if any(keyword in line.lower() for keyword in ['found', 'match', 'result']):
                summary_lines.append(line)
        
        if len(lines) > 20:
            summary_lines.append(f"...[{len(lines) - 20} more lines truncated]")
        
        return '\n'.join(summary_lines)

    def _summarize_file_content(self, result: str) -> str:
        """Summarize file content keeping structure"""
        lines = result.split('\n')
        
        # Keep first 30 and last 10 lines for context
        if len(lines) <= 50:
            return result
        
        summary = []
        summary.extend(lines[:30])
        summary.append(f"...[{len(lines) - 40} lines omitted]...")
        summary.extend(lines[-10:])
        
        return '\n'.join(summary)

    def _summarize_directory_listing(self, result: str) -> str:
        """Summarize directory listing keeping important files"""
        lines = result.split('\n')
        important_extensions = {'.py', '.js', '.ts', '.json', '.yaml', '.yml', '.md', '.txt'}
        
        important_files = []
        other_count = 0
        
        for line in lines:
            if any(ext in line for ext in important_extensions):
                important_files.append(line)
            else:
                other_count += 1
        
        summary = important_files[:20]  # First 20 important files
        if other_count > 0:
            summary.append(f"... and {other_count} other files")
        
        return '\n'.join(summary)

    def _process_tool_result(self, content: str) -> str:
        """Process tool result to optimize for context window"""
        if len(content) <= self.max_tool_result_length:
            return content
        
        # Try to find natural break points
        sentences = content.split('. ')
        processed = ""
        
        for sentence in sentences:
            if len(processed + sentence) > self.max_tool_result_length:
                break
            processed += sentence + ". "
        
        if not processed:  # Fallback if no sentences found
            processed = content[:self.max_tool_result_length]
        
        return processed + f"...[truncated from {len(content)} chars]"

    def _check_and_compress(self):
        """Check if compression is needed and perform it"""
        if self.current_context_size > self.compression_threshold:
            self._compress_old_conversations()

    def _compress_old_conversations(self):
        """Compress old conversations while maintaining tool_use/tool_result pairing"""
        if len(self.conversation_history) <= 8:  # Keep at least 8 recent messages for tool pairs
            return
        
        # Find safe compression point that doesn't break tool pairs
        safe_compression_point = self._find_safe_compression_point()
        
        if safe_compression_point <= 2:  # Not worth compressing if too few messages
            return
        
        # Move older conversations to compressed history
        to_compress = self.conversation_history[:safe_compression_point]
        self.conversation_history = self.conversation_history[safe_compression_point:]
        
        # Create summary of compressed conversations
        if to_compress:
            self.compressed_history.extend(to_compress)
            self._update_context_size()
        
        self.last_compression_time = time.time()

    def _find_safe_compression_point(self) -> int:
        """Find a safe point to compress that doesn't break tool_use/tool_result pairs"""
        if len(self.conversation_history) <= 8:
            return 0
        
        # Start from the end and work backwards, looking for a safe cut point
        # We want to keep at least 6 messages, so check up to len - 6
        max_compression = len(self.conversation_history) - 6
        
        # Look for a point where we don't have unpaired tool_use/tool_result
        for i in range(max_compression - 1, -1, -1):
            # Check if cutting at position i would leave unpaired tools
            remaining_messages = self.conversation_history[i:]
            
            if self._messages_have_valid_tool_pairs(remaining_messages):
                return i
        
        # If no safe point found, compress minimal amount
        return max(0, len(self.conversation_history) - 8)

    def _messages_have_valid_tool_pairs(self, messages: List[Dict[str, Any]]) -> bool:
        """Check if a sequence of messages has valid tool_use/tool_result pairs"""
        pending_tool_use_ids = set()
        
        for message in messages:
            if message.get("role") == "assistant":
                # Collect tool_use IDs
                for block in message.get("content", []):
                    if block.get("type") == "tool_use":
                        pending_tool_use_ids.add(block.get("id"))
            
            elif message.get("role") == "user":
                # Check for tool_result and remove matching IDs
                for block in message.get("content", []):
                    if block.get("type") == "tool_result":
                        tool_use_id = block.get("tool_use_id")
                        pending_tool_use_ids.discard(tool_use_id)
        
        # Valid if no pending tool_use IDs (all are matched)
        return len(pending_tool_use_ids) == 0

    def _create_context_summary(self) -> str:
        """Create a summary of compressed history"""
        if not self.compressed_history:
            return ""
        
        # Extract key information from compressed history
        user_intents = []
        assistant_actions = []
        
        for msg in self.compressed_history[-20:]:  # Last 20 compressed messages
            if msg["role"] == "user":
                content = self._extract_text_content(msg)
                if content and len(content) < 200:
                    user_intents.append(content[:100])
            elif msg["role"] == "assistant":
                # Extract what the assistant did
                content = self._extract_text_content(msg)
                if content:
                    assistant_actions.append(content[:100])
        
        summary_parts = []
        if user_intents:
            summary_parts.append(f"Previous requests: {'; '.join(user_intents[-3:])}")
        if assistant_actions:
            summary_parts.append(f"Previous actions: {'; '.join(assistant_actions[-3:])}")
        
        return " | ".join(summary_parts)

    def _extract_text_content(self, message: Dict[str, Any]) -> str:
        """Extract text content from message"""
        content = message.get("content", [])
        if isinstance(content, str):
            return content
        
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        
        return " ".join(text_parts)

    def _estimate_message_size(self, message: Dict[str, Any]) -> int:
        """Estimate message size for context tracking"""
        return len(json.dumps(message))

    def _update_context_size(self):
        """Recalculate current context size"""
        total_size = 0
        if self.system_message:
            total_size += len(self.system_message["content"])
        
        for msg in self.conversation_history:
            total_size += self._estimate_message_size(msg)
        
        self.current_context_size = total_size

    def get_concise_tool_summary(self) -> str:
        """Get a concise summary of tool usage"""
        if not self.tool_calls_history:
            return ""
        
        tool_counts = {}
        for call in self.tool_calls_history:
            tool = call["tool"]
            tool_counts[tool] = tool_counts.get(tool, 0) + 1
        
        summary = []
        for tool, count in tool_counts.items():
            summary.append(f"{tool}({count})")
        
        return ", ".join(summary)

    def get_tool_usage_summary(self) -> str:
        """Get detailed tool usage summary for agent reflection"""
        if not self.tool_calls_history:
            return "No tools used yet."
        
        summary = f"Session: {self.total_tool_calls} tool calls\n"
        
        # Recent successful tools
        recent_successful = [
            call for call in self.tool_calls_history[-5:] 
            if call.get("success", True)
        ]
        
        if recent_successful:
            summary += "Recent successful tools:\n"
            for call in recent_successful:
                args_str = str(call["arguments"])[:50]
                summary += f"- {call['tool']}: {args_str}...\n"
        
        return summary

    def cleanup_session(self):
        """Clean up session data while preserving important context"""
        # Keep only essential tool calls
        self.tool_calls_history = self.tool_calls_history[-10:]
        
        # Clear old compressed history
        if len(self.compressed_history) > 50:
            self.compressed_history = self.compressed_history[-25:]
        
        self._update_context_size()

    def get_session_stats(self) -> Dict[str, Any]:
        """Get session statistics"""
        duration = time.time() - self.session_start_time
        return {
            "duration_minutes": round(duration / 60, 2),
            "total_tool_calls": self.total_tool_calls,
            "tools_used": list(self.tools_used_session),
            "context_size": self.current_context_size,
            "compressed_messages": len(self.compressed_history),
            "active_messages": len(self.conversation_history)
        }

    def debug_tool_pairing(self) -> str:
        """Debug method to check tool_use/tool_result pairing in recent messages"""
        if not self.conversation_history:
            return "No conversation history"
        
        debug_info = []
        recent_messages = self.conversation_history[-6:]  # Check last 6 messages
        
        for i, msg in enumerate(recent_messages):
            role = msg.get("role", "unknown")
            content = msg.get("content", [])
            
            tools_info = []
            for block in content:
                if block.get("type") == "tool_use":
                    tools_info.append(f"tool_use:{block.get('id', 'no_id')}")
                elif block.get("type") == "tool_result":
                    tools_info.append(f"tool_result:{block.get('tool_use_id', 'no_id')}")
            
            if tools_info:
                debug_info.append(f"Msg {i}: {role} - {', '.join(tools_info)}")
            else:
                debug_info.append(f"Msg {i}: {role} - no tools")
        
        # Check if pairing is valid
        valid_pairing = self._messages_have_valid_tool_pairs(recent_messages)
        debug_info.append(f"Valid tool pairing: {valid_pairing}")
        
        return "\n".join(debug_info)