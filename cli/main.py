"""
Entry point for the Code Generation Assistant.
"""
import os
import sys

# Add the src directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'src'))

from src.cli.interface import main as cli_main

if __name__ == "__main__":
    cli_main()