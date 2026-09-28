import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://raphadi.app.n8n.cloud/webhook/nexus-ai';
const REQUEST_TIMEOUT = 60000; // 60 seconds

const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');
const PINNED_FILE = path.join(__dirname, 'pinned.json');

// System mode prompts matching chatbot.py / app.py
const MODES: Record<string, string> = {
  General: '',
  Coder: 'System instruction: act as an expert programmer. Answer with clean, working code and a brief explanation.',
  Writer: 'System instruction: act as a professional writer. Focus on tone, clarity and structure.',
  Translator: "System instruction: act as a translator. Translate the user's text unless asked otherwise.",
  'Roman Urdu': 'System instruction: reply in Roman Urdu (Urdu/Hindi written in English script) unless the user asks for another language.',
};

function loadAllConversations(): Record<string, any> {
  try {
    if (!fs.existsSync(CONVERSATIONS_FILE)) {
      return {};
    }
    const data = fs.readFileSync(CONVERSATIONS_FILE, 'utf-8');
    return JSON.parse(data) || {};
  } catch (err) {
    console.error('Error loading conversations:', err);
    return {};
  }
}

function saveAllConversations(data: Record<string, any>) {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving conversations:', err);
  }
}

function loadPinned(): string[] {
  try {
    if (!fs.existsSync(PINNED_FILE)) {
      return [];
    }
    const data = fs.readFileSync(PINNED_FILE, 'utf-8');
    return JSON.parse(data) || [];
  } catch {
    return [];
  }
}

function savePinned(pinned: string[]) {
  try {
    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving pinned:', err);
  }
}

function extractReplyText(data: any): string | null {
  if (Array.isArray(data) && data.length > 0) {
    data = data[0];
  }

  if (typeof data === 'object' && data !== null) {
    const keys = ['output', 'response', 'text', 'reply', 'answer', 'message'];
    for (const key of keys) {
      const val = data[key];
      if (typeof val === 'string' && val.trim()) {
        return val;
      }
    }

    if (data.message && typeof data.message === 'object') {
      const content = data.message.content;
      if (typeof content === 'string' && content.trim()) {
        return content;
      }
    }
  }

  if (typeof data === 'string' && data.trim()) {
    return data;
  }

  return null;
}

async function callN8n(messageText: string, sessionId: string): Promise<{ reply: string; status: 'ok' | 'error' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: messageText,
        session_id: sessionId,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          reply:
            "⚠️ The n8n webhook returned 404 (not found). If this is a 'webhook-test' URL, make sure the workflow is open in the n8n editor with 'Listen for test event' clicked before sending a message. For always-on use, activate the workflow and use its production '/webhook/...' URL instead.",
          status: 'error',
        };
      }
      return {
        reply: `⚠️ n8n webhook error (HTTP ${response.status}): ${response.statusText}`,
        status: 'error',
      };
    }

    let parsed: any;
    const text = await response.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    const reply = extractReplyText(parsed);
    if (reply) {
      return { reply, status: 'ok' };
    }

    return {
      reply: "⚠️ NEXUS AI replied, but in a format I didn't recognize. Check the n8n workflow's response node.",
      status: 'error',
    };
  } catch (error: any) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      return {
        reply: '⚠️ The n8n workflow took too long to respond. Please try again.',
        status: 'error',
      };
    }
    return {
      reply: `⚠️ Couldn't reach the n8n webhook: ${error.message || error}. Check your internet connection and the URL.`,
      status: 'error',
    };
  }
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // --- API Endpoints ---

  // Health / status check
  app.get('/api/status', async (_req: Request, res: Response) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let webhookStatus = 'unknown';

      try {
        const ping = await fetch(N8N_WEBHOOK_URL, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        webhookStatus = `HTTP ${ping.status}`;
      } catch (err: any) {
        clearTimeout(timeout);
        webhookStatus = err.name === 'AbortError' ? 'timeout' : 'unreachable';
      }

      res.json({
        app: 'NEXUS AI',
        status: 'online',
        webhookUrl: N8N_WEBHOOK_URL.replace(/(https?:\/\/)([^@]+@)?([^\/]+)(.*)/, '$1$3/...'),
        webhookStatus,
        modes: Object.keys(MODES),
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // Chat message endpoint
  app.post('/api/chat', async (req: Request, res: Response) => {
    try {
      const { message = '', session_id = 'default-session', mode = 'General', file } = req.body;

      let prompt = message.trim();
      const modeInstruction = MODES[mode] || '';

      // Mode prefix
      if (modeInstruction) {
        prompt = `${modeInstruction}\n\n${prompt}`;
      }

      // Handle attached file
      if (file && file.name) {
        const fileName = (file.name || '').toLowerCase();
        const userPrompt = prompt.trim() || "Please analyze this file and summarize what's in it.";

        // Image files
        if (fileName.match(/\.(png|jpg|jpeg|webp)$/i)) {
          prompt = `${userPrompt}\n\n[The user attached an image named '${file.name}'. This chat workflow can't view image contents directly — let them know, and offer to help in another way.]`;
        }
        // Audio files
        else if (fileName.match(/\.(mp3|wav|m4a|mp4)$/i)) {
          return res.json({
            reply:
              "I received your audio file, but this chat workflow can't transcribe audio yet. Text, PDF, DOCX, CSV, and Excel files all work — feel free to try one of those instead.",
            status: 'ok',
          });
        }
        // Document / code / data files
        else if (file.content) {
          const fileText = String(file.content).slice(0, 20000);
          prompt = `${userPrompt}\n\n[Attached file: ${file.name}]\n--- FILE CONTENT START ---\n${fileText}\n--- FILE CONTENT END ---`;
        }
      }

      if (!prompt.trim()) {
        return res.status(400).json({ error: 'Message or file content is required' });
      }

      const result = await callN8n(prompt, session_id);
      res.json(result);
    } catch (err: any) {
      console.error('Error in /api/chat:', err);
      res.status(500).json({
        reply: `⚠️ Server error: ${err.message || 'Internal error'}`,
        status: 'error',
      });
    }
  });

  // Get all saved conversations
  app.get('/api/conversations', (_req: Request, res: Response) => {
    try {
      const all = loadAllConversations();
      const list = Object.values(all).sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0));
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single conversation
  app.get('/api/conversations/:id', (req: Request, res: Response) => {
    try {
      const all = loadAllConversations();
      const conv = all[req.params.id];
      if (!conv) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.json(conv);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Save or update conversation
  app.post('/api/conversations', (req: Request, res: Response) => {
    try {
      const { id, title, messages } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'Conversation id is required' });
      }
      const all = loadAllConversations();
      all[id] = {
        id,
        title: title || 'Untitled Conversation',
        messages: messages || [],
        updated_at: Date.now() / 1000,
      };
      saveAllConversations(all);
      res.json({ success: true, conversation: all[id] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete conversation
  app.delete('/api/conversations/:id', (req: Request, res: Response) => {
    try {
      const all = loadAllConversations();
      if (all[req.params.id]) {
        delete all[req.params.id];
        saveAllConversations(all);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete all conversations
  app.delete('/api/conversations', (_req: Request, res: Response) => {
    try {
      saveAllConversations({});
      savePinned([]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pinned conversations
  app.get('/api/pinned', (_req: Request, res: Response) => {
    res.json(loadPinned());
  });

  app.post('/api/pinned', (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (Array.isArray(ids)) {
        savePinned(ids);
      }
      res.json({ success: true, pinned: loadPinned() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search conversations and chat history
  app.get('/api/search', (req: Request, res: Response) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!q) {
      return res.json({ conversations: [], matches: [] });
    }

    const all = loadAllConversations();
    const matchedConvs: any[] = [];
    const matchedMessages: any[] = [];

    for (const conv of Object.values(all) as any[]) {
      const title = String(conv.title || '').toLowerCase();
      let convMatched = title.includes(q);

      for (const msg of conv.messages || []) {
        const content = String(msg.content || '');
        if (content.toLowerCase().includes(q)) {
          convMatched = true;
          matchedMessages.push({
            conversation_id: conv.id,
            title: conv.title,
            role: msg.role,
            content,
            ts: msg.ts,
          });
        }
      }

      if (convMatched) {
        matchedConvs.push(conv);
      }
    }

    res.json({
      conversations: matchedConvs,
      matches: matchedMessages,
    });
  });

  // --- Vite Dev Server Middleware or Static Build ---
  const distDir = path.join(__dirname, 'dist');
  const distIndex = path.join(distDir, 'index.html');

  if (fs.existsSync(distIndex) && (process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC === 'true')) {
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(distIndex);
    });
  } else {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (e) {
      if (fs.existsSync(distIndex)) {
        app.use(express.static(distDir));
        app.get('*', (_req: Request, res: Response) => {
          res.sendFile(distIndex);
        });
      }
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✦ NEXUS AI Workspace Server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
