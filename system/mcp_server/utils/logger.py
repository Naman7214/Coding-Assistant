import logging
import sys


# Configure the logger
def setup_logger(name="coding_agent", level=logging.INFO):
    """Setup and return a simple logger"""
    logger = logging.getLogger(name)

    # Avoid adding multiple handlers if logger already exists
    if logger.handlers:
        return logger

    logger.setLevel(level)

    # Create console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)

    # Create formatter
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    console_handler.setFormatter(formatter)

    # Add handler to logger
    logger.addHandler(console_handler)

    return logger


# Create default logger instance
logger = setup_logger()


# Convenience functions for direct use
def info(message):
    """Log info message"""
    logger.info(message)


def debug(message):
    """Log debug message"""
    logger.debug(message)


def warning(message):
    """Log warning message"""
    logger.warning(message)


def error(message):
    """Log error message"""
    logger.error(message)


def critical(message):
    """Log critical message"""
    logger.critical(message)


# Optional: Function to set log level
def set_level(level):
    """Set logging level (e.g., logging.DEBUG, logging.INFO, etc.)"""
    logger.setLevel(level)
    for handler in logger.handlers:
        handler.setLevel(level)
