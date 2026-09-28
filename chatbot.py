"""
chatbot.py
==========
NEXUS AI backend logic — talks to your n8n "NEXUS AI" AI Agent workflow
over its webhook, so no OpenAI API key is needed on the Python side
(n8n's AI Gateway handles the model call for you).

Provides every function App_features.py imports:
    - delete_all_conversations
    - delete_conversation
    - get_file_info
    - get_file_response
    - get_response
    - load_conversations
    - save_conversation
    - search_chat_history
    - search_saved_conversations

Conversations are stored locally in conversations.json (same folder
as this file) so the sidebar's history/search/pin features work
even though the AI reply itself comes from n8n.

IMPORTANT — webhook-test vs. production:
    A "webhook-test" URL only works while you have the workflow open
    in the n8n editor with "Listen for test event" clicked. For normal,
    always-on use:
        1. Open the workflow in n8n
        2. Toggle it to "Active" (top-right)
        3. Its URL changes from .../webhook-test/... to .../webhook/...
        4. Paste that URL into N8N_WEBHOOK_URL below
"""

import os
import io
import json
import time
import uuid
import requests

try:
    from pypdf import PdfReader
except Exception:
    try:
        from PyPDF2 import PdfReader
    except Exception:
        PdfReader = None

try:
    import docx
except Exception:
    docx = None

try:
    import pandas as pd
except Exception:
    pd = None


N8N_WEBHOOK_URL = os.environ.get("N8N_WEBHOOK_URL", "https://raphadi.app.n8n.cloud/webhook/nexus-ai")

REQUEST_TIMEOUT = 60

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
CONVERSATIONS_FILE = os.path.join(DATA_DIR, "conversations.json")


def _extract_reply_text(data):
    if isinstance(data, list) and data:
        data = data[0]

    if isinstance(data, dict):
        for key in ("output", "response", "text", "reply", "answer", "message"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value
        message = data.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content

    if isinstance(data, str) and data.strip():
        return data

    return None


def _call_n8n(message_text, session_id):
    try:
        response = requests.post(
            N8N_WEBHOOK_URL,
            json={
                "message": message_text,
                "session_id": session_id,
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()

        try:
            data = response.json()
        except Exception:
            data = response.text

        reply = _extract_reply_text(data)

        if reply:
            return reply

        return (
            "⚠️ NEXUS AI replied, but in a format I didn't recognize. "
            "Check the n8n workflow's response node."
        )

    except requests.exceptions.ConnectionError:
        return "⚠️ Couldn't reach the n8n webhook. Check your internet connection and the URL."

    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        if status == 404:
            return (
                "⚠️ The n8n webhook returned 404 (not found). If this is a "
                "'webhook-test' URL, make sure the workflow is open in the "
                "n8n editor with 'Listen for test event' clicked before "
                "sending a message. For always-on use, activate the "
                "workflow and use its production '/webhook/...' URL instead."
            )
        return f"⚠️ n8n webhook error (HTTP {status}): {e}"

    except requests.exceptions.Timeout:
        return "⚠️ The n8n workflow took too long to respond. Please try again."

    except Exception as e:
        return f"⚠️ Unexpected error calling n8n: {e}"


def _load_all():
    if not os.path.exists(CONVERSATIONS_FILE):
        return {}
    try:
        with open(CONVERSATIONS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_all(data):
    try:
        with open(CONVERSATIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def save_conversation(conversation_id, title, messages):
    data = _load_all()
    data[conversation_id] = {
        "id": conversation_id,
        "title": title or "Untitled Conversation",
        "messages": messages,
        "updated_at": time.time(),
    }
    _save_all(data)
    return True


def load_conversations(conversation_id=None):
    data = _load_all()

    if conversation_id is not None:
        return data.get(conversation_id)

    conversations = list(data.values())
    conversations.sort(key=lambda c: c.get("updated_at", 0), reverse=True)
    return conversations


def delete_conversation(conversation_id):
    data = _load_all()
    if conversation_id in data:
        del data[conversation_id]
        _save_all(data)
    return True


def delete_all_conversations():
    _save_all({})
    return True


def search_saved_conversations(query):
    query_lower = (query or "").lower().strip()
    if not query_lower:
        return load_conversations()

    results = []
    for conv in load_conversations():
        title = str(conv.get("title", "")).lower()
        if query_lower in title:
            results.append(conv)
            continue
        for message in conv.get("messages", []):
            content = str(message.get("content", "")).lower()
            if query_lower in content:
                results.append(conv)
                break
    return results


def search_chat_history(query):
    query_lower = (query or "").lower().strip()
    matches = []
    if not query_lower:
        return matches

    for conv in load_conversations():
        for message in conv.get("messages", []):
            content = str(message.get("content", ""))
            if query_lower in content.lower():
                matches.append({
                    "conversation_id": conv.get("id"),
                    "title": conv.get("title"),
                    "role": message.get("role"),
                    "content": content,
                })
    return matches


def get_response(text, conversation_id=None):
    session_id = conversation_id or str(uuid.uuid4())
    return _call_n8n(text, session_id)


def get_file_info(uploaded_file):
    try:
        name = uploaded_file.name
        size = uploaded_file.size
        if size >= 1024 * 1024:
            size_text = f"{size / (1024 * 1024):.2f} MB"
        elif size >= 1024:
            size_text = f"{size / 1024:.2f} KB"
        else:
            size_text = f"{size} bytes"
        return f"{name} • {size_text}"
    except Exception:
        return "File attached"


def _extract_text_from_file(uploaded_file):
    name = (uploaded_file.name or "").lower()

    try:
        uploaded_file.seek(0)
    except Exception:
        pass

    raw = uploaded_file.getvalue()

    if name.endswith((".txt", ".md", ".py", ".json", ".csv")):
        try:
            return raw.decode("utf-8", errors="ignore")[:15000]
        except Exception:
            return ""

    if name.endswith((".xlsx", ".xls")):
        if pd is None:
            return "[Spreadsheet support needs: pip install pandas openpyxl]"
        try:
            df = pd.read_excel(io.BytesIO(raw))
            return df.to_string()[:15000]
        except Exception as e:
            return f"[Could not read spreadsheet: {e}]"

    if name.endswith(".pdf"):
        if PdfReader is None:
            return "[PDF support needs: pip install pypdf]"
        try:
            reader = PdfReader(io.BytesIO(raw))
            text = ""
            for page in reader.pages:
                text += page.extract_text() or ""
            return text[:15000]
        except Exception as e:
            return f"[Could not read PDF: {e}]"

    if name.endswith(".docx"):
        if docx is None:
            return "[Word doc support needs: pip install python-docx]"
        try:
            document = docx.Document(io.BytesIO(raw))
            return "\n".join(p.text for p in document.paragraphs)[:15000]
        except Exception as e:
            return f"[Could not read Word document: {e}]"

    return ""


def get_file_response(text, uploaded_file, conversation_id=None):
    name = (uploaded_file.name or "").lower()

    user_text = text.strip() if text and text.strip() else (
        "Please analyze this file and summarize what's in it."
    )

    if name.endswith((".png", ".jpg", ".jpeg", ".webp")):
        combined = (
            f"{user_text}\n\n[The user attached an image named "
            f"'{uploaded_file.name}'. This chat workflow can't view image "
            f"contents directly — let them know, and offer to help in "
            f"another way.]"
        )
        return get_response(combined, conversation_id)

    if name.endswith((".mp3", ".wav", ".m4a", ".mp4")):
        return (
            "I received your audio file, but this chat workflow can't "
            "transcribe audio yet. Text, PDF, DOCX, CSV, and Excel files "
            "all work — feel free to try one of those instead."
        )

    file_text = _extract_text_from_file(uploaded_file)

    if not file_text.strip():
        return (
            "I received the file, but I couldn't extract any readable "
            "content from it. Please try a different format."
        )

    combined_prompt = (
        f"{user_text}\n\n"
        f"[Attached file: {uploaded_file.name}]\n"
        f"--- FILE CONTENT START ---\n"
        f"{file_text}\n"
        f"--- FILE CONTENT END ---"
    )

    return get_response(combined_prompt, conversation_id)
