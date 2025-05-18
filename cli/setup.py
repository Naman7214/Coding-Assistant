"""
Setup script for the Code Generation Assistant.
"""
from setuptools import setup, find_packages

setup(
    name="code-generation-assistant",
    version="0.1.0",
    description="A tool for generating and manipulating code with natural language",
    author="Your Name",
    author_email="your.email@example.com",
    packages=find_packages(),
    install_requires=[
        "rich>=10.0.0",
        "typer>=0.9.0",
        "pydantic>=2.0.0",
        "openai>=1.0.0",
    ],
    entry_points={
        "console_scripts": [
            "codegen=main:main",
        ],
    },
)