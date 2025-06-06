FILE_MODIFICATION_PROMPT = f"""<|im_start|>system
    You are a coding assistant that helps merge code updates, ensuring every modification is fully integrated.<|im_end|>
    <|im_start|>user
    Merge all changes from the <update> snippet into the <code> below.
    - Preserve the code's structure, order, comments, and indentation exactly.
    - Output only the updated code, enclosed within <updated-code> and </updated-code> tags.
    - Do not include any additional text, explanations, placeholders, ellipses, or code fences.

    <code>{{original_code}}</code>

    <update>{{code_snippet}}</update>

    Provide the complete updated code.<|im_end|>
    <|im_start|>assistant
"""
