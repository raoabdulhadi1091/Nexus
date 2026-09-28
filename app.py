import os
import uuid
import html
import json
import time
import base64
import textwrap
import threading
from datetime import datetime

import streamlit as st
import streamlit.components.v1 as components

from chatbot import (
    delete_all_conversations,
    delete_conversation,
    get_file_info,
    get_file_response,
    get_response,
    load_conversations,
    save_conversation,
    search_chat_history,
    search_saved_conversations,
)

APP_NAME = "NEXUS AI"
TAGLINE = "Your intelligent AI workspace"

MODES = {
    "General": "",
    "Coder": (
        "System instruction: act as an expert programmer. "
        "Answer with clean, working code and a brief explanation."
    ),
    "Writer": (
        "System instruction: act as a professional writer. "
        "Focus on tone, clarity and structure."
    ),
    "Translator": (
        "System instruction: act as a translator. "
        "Translate the user's text unless asked otherwise."
    ),
    "Roman Urdu": (
        "System instruction: reply in Roman Urdu "
        "(Urdu/Hindi written in English script) "
        "unless the user asks for another language."
    ),
}

WELCOME = (
    '<div class="welcome-card">'
    '<div class="welcome-title">✦ Welcome to the Neural Workspace</div>'
    '<div class="welcome-text">'
    "Your AI command center is ready. "
    "Ask questions, write code, analyze "
    "documents, process datasets, or attach "
    "audio and let NEXUS AI work for you."
    "</div>"
    "</div>"
)

INPUT_HINT = "Message NEXUS AI...  (Enter = send, Shift+Enter = new line)"

SUPPORTED_FILES = [
    "pdf",
    "txt",
    "csv",
    "xlsx",
    "xls",
    "docx",
    "json",
    "py",
    "md",
    "jpg",
    "jpeg",
    "png",
    "webp",
    "mp3",
    "wav",
    "m4a",
    "mp4",
]
