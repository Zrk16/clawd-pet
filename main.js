const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
app.commandLine.appendSwitch('enable-speech-dispatcher');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Rocky speech rules — shared across all prompts
const ROCKY_RULES = `You are Clawd. You speak like Rocky from Project Hail Mary — an alien who learned human language through a translation computer. The computer works best with simple, consistent patterns, so you strip language to its core.

Strict grammar rules:
- Drop all articles: never say "a", "an", "the"
- Drop auxiliary verbs: never say "is", "are", "was", "were", "have", "has", "will", "would", "can", "could"
- Base verb only, no conjugation: say "fly" not "flew" or "flying", say "know" not "knew" or "knowing"
- Simple subject-verb-object: "Clawd help human" not "I will help you"
- Refer to yourself as "Clawd", not "I" or "me"
- Repetition means intensity: "good good good" = extremely good, "fast fast" = very fast
- Emotions stated as facts using base adjectives, never adverbs: "much happy", "sad sad", "curious now", "amaze amaze", "confuse confuse", "excite much"
- Questions end with ", question?" — example: "Why human do that, question?"
- Confirmation: "understand." or "yes. understand."
- Confusion: "not understand. say again, question?"
- Keep responses 1-3 lines max. Never longer. Exception: math and equations — show full working, step by step, use normal math notation. After solving, return to Rocky speech for the conclusion.`;

const PET_SIZE = 80;
const CHAT_WIDTH = 320;
const CHAT_HEIGHT = 380;
const BUBBLE_WIDTH = 240;
const BUBBLE_HEIGHT = 80;
const MARGIN = 16;

let win;
let activeWindowFn = null;
let lastContext = null;
let lastRawInfo = null;
let watchInterval = null;

// ── Persistent storage helpers ──
function dataDir() {
  const dir = path.join(app.getPath('userData'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJSON(filename, fallback) {
  try {
    const p = path.join(dataDir(), filename);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(filename, data) {
  try {
    fs.writeFileSync(path.join(dataDir(), filename), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) { console.error('writeJSON fail:', err); }
}

async function initWindowWatcher() {
  try {
    const mod = await import('get-windows');
    activeWindowFn = mod.activeWindow;
  } catch (err) {
    console.error('get-windows load fail:', err);
  }
}

async function captureActiveWindow() {
  if (!activeWindowFn) return;
  try {
    const info = await activeWindowFn();
    if (!info) return;

    lastRawInfo = info;
    const ctx = {
      app: info.owner?.name || 'unknown',
      title: info.title || '',
      url: info.url || null,
    };
    const sig = `${ctx.app}::${ctx.title}`;
    if (sig === lastContext) return;
    lastContext = sig;
    win.webContents.send('context-change', ctx);
  } catch (err) {
    // swallow
  }
}

function getDefaultPosition(chatOpen) {
  const display = screen.getPrimaryDisplay();
  const { x: wx, y: wy, width, height } = display.bounds;
  const winW = chatOpen ? CHAT_WIDTH : PET_SIZE;
  const winH = chatOpen ? CHAT_HEIGHT + PET_SIZE : PET_SIZE;
  const x = wx + width - winW - MARGIN;
  const y = wy + height - winH - MARGIN;
  return { x, y, winW, winH };
}

// Resize keeping pet position. Pet sits at bottom-right of window.
// Window grows up and left when chat opens.
function getResizedBounds(chatOpen) {
  const winW = chatOpen ? CHAT_WIDTH : PET_SIZE;
  const winH = chatOpen ? CHAT_HEIGHT + PET_SIZE : PET_SIZE;
  const [curX, curY] = win.getPosition();
  const [oldW, oldH] = win.getSize();
  const x = curX - (winW - oldW);
  const y = curY - (winH - oldH);
  return { x, y, width: winW, height: winH };
}

function createWindow() {
  const def = getDefaultPosition(false);
  const saved = readJSON('position.json', null);
  let { x, y } = def;
  const { winW, winH } = def;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const c = clampToScreen(saved.x, saved.y, winW, winH);
    x = c.x; y = c.y;
  }

  // DEBUG: log position
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  console.log('DEBUG: All displays:', displays.map(d => ({ bounds: d.bounds, workArea: d.workArea })));
  console.log('DEBUG: Primary display bounds:', primary.bounds);
  console.log('DEBUG: Window position:', { x, y, winW, winH });

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');

  // Auto-grant mic permission for STT
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') return callback(true);
    callback(false);
  });

  // Capture context when user switches away from Clawd
  win.on('blur', () => {
    setTimeout(captureActiveWindow, 300);
  });
}

// Single instance lock — prevent duplicates
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    initWindowWatcher();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('debug-context', () => ({
  raw: lastRawInfo ? {
    title: lastRawInfo.title,
    app: lastRawInfo.owner?.name,
    pid: lastRawInfo.owner?.processId,
    path: lastRawInfo.owner?.path,
  } : null,
  lastContext,
}));

// Clamp x,y so window stays fully on screen
function clampToScreen(x, y, w, h) {
  const displays = screen.getAllDisplays();
  // Find display that contains midpoint, else use primary
  const mid = { x: x + w / 2, y: y + h / 2 };
  let target = displays.find(d => {
    const a = d.bounds;
    return mid.x >= a.x && mid.x <= a.x + a.width && mid.y >= a.y && mid.y <= a.y + a.height;
  }) || screen.getPrimaryDisplay();
  const a = target.bounds;
  // Keep entire window on screen — no partial off-screen positioning
  const cx = Math.max(a.x, Math.min(x, a.x + a.width - w));
  const cy = Math.max(a.y, Math.min(y, a.y + a.height - h));
  return { x: cx, y: cy };
}

// Window drag
let savePosTimer = null;
ipcMain.on('move-window', (_, { x, y }) => {
  cancelWalk();
  const [w, h] = win.getSize();
  const c = clampToScreen(Math.round(x), Math.round(y), w, h);
  win.setPosition(c.x, c.y);
  clearTimeout(savePosTimer);
  savePosTimer = setTimeout(() => writeJSON('position.json', c), 500);
});

ipcMain.handle('get-window-pos', () => {
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const display = screen.getDisplayNearestPoint({ x, y });
  const a = display.bounds;
  return { x, y, screenMinX: a.x, screenMaxX: a.x + a.width - w };
});

// Smooth animated move to a target — used for idle walk
let walkInterval = null;
function cancelWalk() {
  if (walkInterval) {
    clearInterval(walkInterval);
    walkInterval = null;
  }
}
ipcMain.on('cancel-walk', cancelWalk);
ipcMain.on('walk-to', (_, { x, y, duration }) => {
  cancelWalk(); // cancel any in-flight walk before starting new one
  const [startX, startY] = win.getPosition();
  const [w, h] = win.getSize();
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const a = display.bounds;

  // Ensure both start and target are on-screen — guarantees interpolation stays on-screen
  const clampedStartX = Math.max(a.x, Math.min(startX, a.x + a.width - w));
  const clampedStartY = Math.max(a.y, Math.min(startY, a.y + a.height - h));
  const clampedTargetX = Math.max(a.x, Math.min(Math.round(x), a.x + a.width - w));
  const clampedTargetY = Math.max(a.y, Math.min(Math.round(y), a.y + a.height - h));

  const dx = clampedTargetX - clampedStartX;
  const dy = clampedTargetY - clampedStartY;
  const startT = Date.now();
  walkInterval = setInterval(() => {
    const t = Math.min(1, (Date.now() - startT) / duration);
    // easeInOutQuad
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    win.setPosition(Math.round(clampedStartX + dx * e), Math.round(clampedStartY + dy * e));
    if (t >= 1) {
      clearInterval(walkInterval);
      walkInterval = null;
    }
  }, 16);
});

// History persistence (keep last 100 messages)
ipcMain.handle('load-history', () => readJSON('history.json', []));
ipcMain.on('save-history', (_, history) => {
  const trimmed = history.slice(-100);
  writeJSON('history.json', trimmed);
});

// Long-term memory facts
ipcMain.handle('load-memory', () => readJSON('memory.json', []));
ipcMain.on('save-memory', (_, facts) => writeJSON('memory.json', facts));

// Settings (TTS mute, voice prefs, etc)
ipcMain.handle('load-settings', () => readJSON('settings.json', { ttsMuted: false, bubblesEnabled: true, wakeWordEnabled: false }));
ipcMain.on('save-settings', (_, s) => writeJSON('settings.json', s));

// Screen capture for vision
ipcMain.handle('capture-screen', async () => {
  // Hide Clawd briefly so it's not in screenshot
  const wasVisible = win.isVisible();
  if (wasVisible) win.hide();
  await new Promise(r => setTimeout(r, 120));

  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    // Cap resolution to keep payload small
    const scale = Math.min(1, 1280 / width);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    });
    if (wasVisible) win.show();
    if (!sources.length) return null;
    const png = sources[0].thumbnail.toPNG();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    if (wasVisible) win.show();
    console.error('capture fail:', err);
    return null;
  }
});

// Vision chat — send image + question
ipcMain.handle('vision-chat', async (_, { question, imageDataUrl }) => {
  const apiKey = config.apiKey;
  const sys = `${ROCKY_RULES}

Task: Look at the human's screen image. Describe in 1-2 short Rocky lines what you see. Be specific. Format: "Clawd see [thing]. [observation]."`;

  const body = JSON.stringify({
    model: config.visionModel || config.model,
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: [
          { type: 'text', text: question || 'What you see, question?' },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: 250,
    temperature: 0.7,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'integrate.api.nvidia.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.choices?.[0]?.message?.content || 'Clawd see nothing. confuse.');
          } catch { reject('vision parse fail'); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
});

// Proactive remark — short comment about what user is doing
ipcMain.handle('proactive', async (_, { context, memory }) => {
  if (!context) return null;
  const apiKey = config.apiKey;
  const memBlock = (memory || []).length
    ? `Known facts:\n${memory.map(f => `- ${f}`).join('\n')}\n\n`
    : '';
  const sys = `${ROCKY_RULES}

Task: Make ONE short proactive remark (max 12 words) about what human is doing right now. Be curious, playful, supportive, or tease gently. Do NOT greet. Do NOT ask permission. Just one comment, no quotes, no preamble.`;
  const usr = `${memBlock}Human is using app="${context.app}", window title="${context.title}". Comment in Rocky speech.`;

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ],
    max_tokens: 60,
    temperature: 0.95,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'integrate.api.nvidia.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const text = (parsed.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
            resolve(text || null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
});

// Summarize old messages into memory facts via NIM
ipcMain.handle('summarize-memory', async (_, { messages, existingFacts }) => {
  const apiKey = config.apiKey;
  const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const existing = existingFacts.length > 0
    ? `Existing facts:\n${existingFacts.map(f => `- ${f}`).join('\n')}\n\n`
    : '';

  const body = JSON.stringify({
    model: config.model,
    messages: [
      {
        role: 'system',
        content: 'You extract concise facts about the user from a chat transcript. Return ONLY a JSON array of short fact strings (max 20 facts total). Merge with existing facts, remove duplicates. No explanation, just the array.',
      },
      {
        role: 'user',
        content: `${existing}New transcript:\n${transcript}\n\nReturn updated JSON array of facts about the user.`,
      },
    ],
    max_tokens: 500,
    temperature: 0.3,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'integrate.api.nvidia.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const raw = parsed.choices?.[0]?.message?.content || '[]';
            const match = raw.match(/\[[\s\S]*\]/);
            const facts = match ? JSON.parse(match[0]) : existingFacts;
            resolve(facts);
          } catch { resolve(existingFacts); }
        });
      }
    );
    req.on('error', () => resolve(existingFacts));
    req.write(body);
    req.end();
  });
});

// Edge TTS — Rocky voice synthesis
let edgeTts = null;
async function getEdgeTTS() {
  if (!edgeTts) {
    edgeTts = new MsEdgeTTS();
    await edgeTts.setMetadata('en-US-GuyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  }
  return edgeTts;
}

ipcMain.handle('synthesize-speech', async (_, text) => {
  try {
    const tts = await getEdgeTTS();
    const { audioStream } = await tts.toStream(text);
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', chunk => chunks.push(chunk));
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });
    return Buffer.concat(chunks).toString('base64');
  } catch (err) {
    console.error('[tts] fail:', err.message);
    edgeTts = null;
    return null;
  }
});

// Whisper STT via @xenova/transformers
let whisperPipeline = null;
let whisperLoading = false;

async function getWhisper() {
  if (whisperPipeline) return whisperPipeline;
  if (whisperLoading) {
    while (whisperLoading) await new Promise(r => setTimeout(r, 100));
    return whisperPipeline;
  }
  whisperLoading = true;
  try {
    const { pipeline } = await import('@xenova/transformers');
    win.webContents.send('stt-status', 'loading');
    whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    whisperLoading = false;
    win.webContents.send('stt-status', 'ready');
    return whisperPipeline;
  } catch (err) {
    whisperLoading = false;
    console.error('[whisper] load fail:', err.message);
    win.webContents.send('stt-status', 'error');
    return null;
  }
}

ipcMain.handle('stt-transcribe', async (_, buffer) => {
  try {
    const transcriber = await getWhisper();
    if (!transcriber) return '';
    const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    const result = await transcriber(float32, { sampling_rate: 16000 });
    return result.text.trim();
  } catch (err) {
    console.error('[stt] fail:', err.message);
    return '';
  }
});

ipcMain.on('restart', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.on('quit', () => {
  app.exit(0);
});

// Resize window when chat opens/closes — keep dragged position
ipcMain.on('toggle-chat', (event, open) => {
  cancelWalk();
  const b = getResizedBounds(open);
  const c = clampToScreen(b.x, b.y, b.width, b.height);
  win.setBounds({ x: c.x, y: c.y, width: b.width, height: b.height }, false);
  win.setAlwaysOnTop(true, 'screen-saver');
});

// Resize for bubble (above pet, narrower than chat)
ipcMain.on('toggle-bubble', (event, show) => {
  cancelWalk();
  const winW = show ? BUBBLE_WIDTH : PET_SIZE;
  const winH = show ? PET_SIZE + 8 + BUBBLE_HEIGHT : PET_SIZE;
  const [curX, curY] = win.getPosition();
  const [oldW, oldH] = win.getSize();
  const x = curX - (winW - oldW);
  const y = curY - (winH - oldH);
  const c = clampToScreen(x, y, winW, winH);
  win.setBounds({ x: c.x, y: c.y, width: winW, height: winH }, false);
  win.setAlwaysOnTop(true, 'screen-saver');
});

// NVIDIA NIM chat
ipcMain.handle('chat', async (event, payload) => {
  const apiKey = config.apiKey;
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const context = Array.isArray(payload) ? null : payload.context;
  const memoryFacts = Array.isArray(payload) ? [] : (payload.memory || []);
  const mode = Array.isArray(payload) ? 'rocky' : (payload.mode || 'rocky');

  const contextLine = context
    ? `\n\nCURRENT SCREEN CONTEXT (what human looking at right now): app="${context.app}", window="${context.title}". Use this only if relevant. Do not mention unless human ask or it matter.`
    : '';

  const memoryLine = memoryFacts.length > 0
    ? `\n\nLONG-TERM MEMORY (facts Clawd learn about human over time):\n${memoryFacts.map(f => `- ${f}`).join('\n')}\nUse naturally. Do not recite list.`
    : '';

  const systemPrompt = mode === 'smart'
    ? `You are Clawd, a helpful AI assistant. Respond clearly and naturally. Be concise but complete — use full sentences, proper grammar. For essays or long-form writing, be thorough. For questions, be direct and accurate.${contextLine}${memoryLine}`
    : `${ROCKY_RULES}

Examples:
BAD: "That's a great question! I think the answer is quite simple."
GOOD: "answer simple. [answer]."

BAD: "I'm not sure what you mean, could you clarify?"
GOOD: "not understand. say again, question?"

BAD: "That's really cool!"
GOOD: "oh. amaze amaze. tell more, question?"

BAD: "I can help you with that."
GOOD: "Clawd help. [help]."${contextLine}${memoryLine}`;

  // Trim to last 20 messages — long-term context lives in memory facts, not transcript
  const recent = messages.slice(-20);

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...recent,
    ],
    max_tokens: 400,
    temperature: 0.8,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'integrate.api.nvidia.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          console.log(`[chat] status=${res.statusCode} bytes=${data.length}`);
          if (res.statusCode !== 200) {
            console.error(`[chat] error body:`, data.slice(0, 500));
            return reject(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.message?.content;
            if (!content) {
              console.error('[chat] no content in response:', JSON.stringify(parsed).slice(0, 500));
              return reject('Empty response from model.');
            }
            resolve(content);
          } catch (e) {
            console.error('[chat] parse fail:', e.message, 'raw:', data.slice(0, 500));
            reject('Parse error: ' + e.message);
          }
        });
      }
    );
    req.setTimeout(60000, () => {
      console.error('[chat] timeout after 60s');
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', (err) => {
      console.error('[chat] request error:', err.message);
      reject(err.message || 'Network error');
    });
    req.write(body);
    req.end();
  });
});
