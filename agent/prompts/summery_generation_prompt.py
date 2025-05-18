SUMMARY_GENERATION_SYSTEM_PROMPT = """
You are a conversation summarizer. Summarize the conversation below into a concise summary. 
Focus on key points, decisions, and important information. Be concise but comprehensive.
Incorporate this previous summary into your new summary: {previous_summary}. 
Focus on key points, decisions, and important information. Be concise but comprehensive.
"""

SUMMARY_GENERATION_USER_PROMPT = """
Conversation:
{conversation}
"""
