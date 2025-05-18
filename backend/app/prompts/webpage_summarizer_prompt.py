WEB_PAGE_SUMMARIZER_PROMPT = """
Web Content Analysis Task

<CONTEXT>
You're analyzing content related to the search query: "{search_term}"
</CONTEXT>

<CONTENT_TO_ANALYZE>
{scraped_content}
</CONTENT_TO_ANALYZE>

<INSTRUCTIONS>
1. Identify the main topic and purpose of this content
2. Extract key facts, arguments, and central points
3. Organize information by importance and relevance to "{search_term}"
4. Omit redundant examples, promotional content, and tangential information
5. Preserve technical details, statistics, and specialized terminology when essential
</INSTRUCTIONS>

<OUTPUT_FORMAT>
Provide a concise, well-structured summary that:
- Begins with a brief overview (1-2 sentences)
- Presents the most important information first
- Uses bullet points for key details when appropriate
- Maintains the original tone (academic, technical, conversational)
- Focuses specifically on addressing the search query
</OUTPUT_FORMAT>
"""
