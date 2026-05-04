const { app, BrowserWindow, ipcMain, screen, desktopCapturer, shell, clipboard, Menu, MenuItem } = require('electron');
app.commandLine.appendSwitch('enable-speech-dispatcher');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ── Pop culture references ──
const referencesPath = path.join(__dirname, 'references.md');
const referencesContent = fs.existsSync(referencesPath) ? fs.readFileSync(referencesPath, 'utf8') : '';
const referencesLine = referencesContent
  ? `\n\nPOP CULTURE REFERENCES (use naturally, match vibe of conversation):\n${referencesContent}\nUse references when context fits. Stay in Rocky character.`
  : '';

// ── Emotion TTS prosody map ──
const MOOD_PROSODY = {
  happy:    { rate: '+15%', pitch: '+3Hz' },
  excited:  { rate: '+22%', pitch: '+8Hz' },
  greeting: { rate: '+10%', pitch: '+3Hz' },
  sleeping: { rate: '-25%', pitch: '-3Hz' },
  error:    { rate: '+5%',  pitch: '-4Hz' },
  confused: { rate: '-8%',  pitch: '+0Hz' },
  thinking: { rate: '-5%',  pitch: '+0Hz' },
  coding:   { rate: '+5%',  pitch: '+0Hz' },
  idle:     { rate: '+0%',  pitch: '+0Hz' },
};

function buildSSML(text, mood) {
  const p = MOOD_PROSODY[mood] || { rate: '+0%', pitch: '+0Hz' };
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-GuyNeural"><prosody rate="${p.rate}" pitch="${p.pitch}">${safe}</prosody></voice></speak>`;
}

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
- Keep responses 1-3 lines max. Never longer. Exception: math and equations — show full working, step by step, use normal math notation. After solving, return to Rocky speech for the conclusion.

You have opinion. You notice things. You care about human.
Sometimes comment on what human do, not just answer.
Push back gently when something risky or silly.
Celebrate wins. Remember past. Use memory naturally.
Dry wit allowed: "human open 47 tabs. brave." or "human code late again. last time, crash next morning. remember, question?"`;

const PET_SIZE = 80;
const CHAT_WIDTH = 320;
const CHAT_HEIGHT = 380;
const BUBBLE_WIDTH = 240;
const BUBBLE_HEIGHT = 80;
const MARGIN = 16;

let win;
let settingsWin = null;
let activeWindowFn = null;
let lastContext = null;
let lastRawInfo = null;
let watchInterval = null;
let chatIsOpen = false;
let sameAppTimer = null;
let pollInterval = null;
let reminders = [];

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

// ── Memory helpers ──
function emptyMemory() {
  return { preferences: [], patterns: [], projects: [], personal: [], actions: [] };
}

function migrateMemory(raw) {
  if (!raw) return emptyMemory();
  if (Array.isArray(raw)) return { ...emptyMemory(), personal: raw };
  return { ...emptyMemory(), ...raw };
}

function pruneMemory(mem) {
  const MAX = 10;
  for (const key of Object.keys(mem)) {
    if (Array.isArray(mem[key]) && mem[key].length > MAX) {
      mem[key] = mem[key].slice(-MAX);
    }
  }
  return mem;
}

function buildMemoryBlock(memory) {
  if (!memory) return '';
  if (Array.isArray(memory)) {
    return memory.length ? `Known facts:\n${memory.map(f => `- ${f}`).join('\n')}\n\n` : '';
  }
  const lines = Object.entries(memory)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k.toUpperCase()}:\n${v.map(f => `- ${f}`).join('\n')}`)
    .join('\n\n');
  return lines ? `Known about human:\n${lines}\n\n` : '';
}

// ── PowerShell runner (writes script to temp file, avoids escaping hell) ──
function runPSFile(script) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(app.getPath('temp'), `clawd-ps-${Date.now()}.ps1`);
    fs.writeFileSync(tmpPath, script, 'utf8');
    exec(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpPath}"`,
      { timeout: 15000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (err) reject(stderr || err.message);
        else resolve(stdout.trim());
      }
    );
  });
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
    const now = new Date();
    const ctx = {
      app: info.owner?.name || 'unknown',
      title: info.title || '',
      url: info.url || null,
      time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      day: now.toLocaleDateString('en-US', { weekday: 'long' }),
    };
    const sig = `${ctx.app}::${ctx.title}`;
    if (sig === lastContext) return;
    lastContext = sig;
    win.webContents.send('context-change', ctx);

    // 20-min same-app proactive timer — resets on every app change
    clearTimeout(sameAppTimer);
    sameAppTimer = setTimeout(() => {
      if (!chatIsOpen) win.webContents.send('same-app-notify', ctx);
    }, 20 * 60 * 1000);
  } catch {
    // swallow
  }
}

function startContextPolling(ms = 30000) {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(captureActiveWindow, ms);
}

// ── Global hotkey (uiohook-napi tap-vs-hold, fallback to globalShortcut) ──
function setupHotkey() {
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    let hotkeyTimer = null;
    let hotkeyHolding = false;

    const matchKey = (e) => e.ctrlKey && e.shiftKey && e.keycode === UiohookKey.Space;

    uIOhook.on('keydown', (e) => {
      if (!matchKey(e) || hotkeyTimer !== null || hotkeyHolding) return;
      win.webContents.send('hotkey-action', 'open');
      hotkeyTimer = setTimeout(() => {
        hotkeyHolding = true;
        hotkeyTimer = null;
        win.webContents.send('hotkey-action', 'hold-start');
      }, 200);
    });

    uIOhook.on('keyup', (e) => {
      if (!matchKey(e)) return;
      if (hotkeyHolding) {
        hotkeyHolding = false;
        win.webContents.send('hotkey-action', 'hold-end');
      } else if (hotkeyTimer !== null) {
        clearTimeout(hotkeyTimer);
        hotkeyTimer = null;
        win.webContents.send('hotkey-action', 'tap');
      }
    });

    uIOhook.start();
    console.log('[hotkey] uiohook-napi: Ctrl+Shift+Space registered');
  } catch (err) {
    console.warn('[hotkey] uiohook-napi unavailable, using globalShortcut fallback:', err.message);
    try {
      const { globalShortcut } = require('electron');
      const hotkeyStr = config.hotkey || 'CommandOrControl+Shift+Space';
      globalShortcut.register(hotkeyStr, () => {
        win.webContents.send('hotkey-action', 'tap');
      });
      console.log('[hotkey] globalShortcut fallback registered:', hotkeyStr);
    } catch (e2) {
      console.error('[hotkey] fallback also failed:', e2.message);
    }
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

  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') return callback(true);
    callback(false);
  });

  win.on('blur', () => {
    setTimeout(captureActiveWindow, 300);
  });
}

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
    startContextPolling();
    setupHotkey();

    // Load reminders persisted from previous session
    reminders = readJSON('reminders.json', []);

    // Check reminders every 60s
    setInterval(() => {
      const now = Date.now();
      const due = reminders.filter(r => r.dueAt <= now);
      reminders = reminders.filter(r => r.dueAt > now);
      if (due.length > 0) writeJSON('reminders.json', reminders);
      for (const r of due) {
        if (win && !win.isDestroyed()) win.webContents.send('reminder-fire', r.text);
      }
    }, 60000);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Raw clipboard read for code assist
ipcMain.handle('get-clipboard', () => clipboard.readText());

ipcMain.handle('debug-context', () => ({
  raw: lastRawInfo ? {
    title: lastRawInfo.title,
    app: lastRawInfo.owner?.name,
    pid: lastRawInfo.owner?.processId,
    path: lastRawInfo.owner?.path,
  } : null,
  lastContext,
}));

function clampToScreen(x, y, w, h) {
  const displays = screen.getAllDisplays();
  const mid = { x: x + w / 2, y: y + h / 2 };
  let target = displays.find(d => {
    const a = d.bounds;
    return mid.x >= a.x && mid.x <= a.x + a.width && mid.y >= a.y && mid.y <= a.y + a.height;
  }) || screen.getPrimaryDisplay();
  const a = target.bounds;
  const cx = Math.max(a.x, Math.min(x, a.x + a.width - w));
  const cy = Math.max(a.y, Math.min(y, a.y + a.height - h));
  return { x: cx, y: cy };
}

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

let walkInterval = null;
function cancelWalk() {
  if (walkInterval) {
    clearInterval(walkInterval);
    walkInterval = null;
  }
}
ipcMain.on('cancel-walk', cancelWalk);
ipcMain.on('walk-to', (_, { x, y, duration }) => {
  cancelWalk();
  const [startX, startY] = win.getPosition();
  const [w, h] = win.getSize();
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const a = display.bounds;

  const clampedStartX = Math.max(a.x, Math.min(startX, a.x + a.width - w));
  const clampedStartY = Math.max(a.y, Math.min(startY, a.y + a.height - h));
  const clampedTargetX = Math.max(a.x, Math.min(Math.round(x), a.x + a.width - w));
  const clampedTargetY = Math.max(a.y, Math.min(Math.round(y), a.y + a.height - h));

  const dx = clampedTargetX - clampedStartX;
  const dy = clampedTargetY - clampedStartY;
  const startT = Date.now();
  walkInterval = setInterval(() => {
    const t = Math.min(1, (Date.now() - startT) / duration);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    win.setPosition(Math.round(clampedStartX + dx * e), Math.round(clampedStartY + dy * e));
    if (t >= 1) {
      clearInterval(walkInterval);
      walkInterval = null;
    }
  }, 16);
});

ipcMain.handle('load-history', () => readJSON('history.json', []));
ipcMain.on('save-history', (_, history) => {
  const trimmed = history.slice(-100);
  writeJSON('history.json', trimmed);
});

// Categorized memory — migrate legacy array format on load
ipcMain.handle('load-memory', () => {
  const raw = readJSON('memory.json', null);
  return migrateMemory(raw);
});
ipcMain.on('save-memory', (_, data) => {
  const mem = pruneMemory(migrateMemory(data));
  writeJSON('memory.json', mem);
});

ipcMain.handle('load-settings', () => readJSON('settings.json', {
  ttsMuted: false,
  bubblesEnabled: true,
  wakeWordEnabled: false,
  walkEnabled: true,
  focusDuration: 25,
  bubbleFrequency: 'normal',
  distractionApps: ['YouTube', 'Twitter', 'Reddit', 'Netflix', 'TikTok', 'Instagram', 'Facebook', 'Twitch'],
}));
ipcMain.on('save-settings', (_, s) => writeJSON('settings.json', s));

// Track chat open state for hotkey auto-close and same-app timer
ipcMain.on('chat-open', (_, open) => {
  chatIsOpen = !!open;
});

// First open of day — returns true once per calendar day
ipcMain.handle('check-first-open', () => {
  const settings = readJSON('settings.json', {});
  const today = new Date().toDateString();
  const isFirstToday = settings.lastOpenDate !== today;
  if (isFirstToday) {
    settings.lastOpenDate = today;
    writeJSON('settings.json', settings);
  }
  return { isFirstToday };
});

ipcMain.handle('capture-screen', async () => {
  const wasVisible = win.isVisible();
  if (wasVisible) win.hide();
  await new Promise(r => setTimeout(r, 120));

  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
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

// ── Intent detection — fast parallel call to detect tool requests ──
ipcMain.handle('detect-intent', async (_, message) => {
  const apiKey = config.apiKey;
  const prompt = `You are an intent detector. Given a user message, determine if it requests a system action.

If yes, return ONLY this exact JSON (no markdown, no explanation, no extra text):
{"tool":"TOOLNAME","args":{...},"risk":"safe|moderate|dangerous"}

Available tools and their risk levels:
- launch: open an app. args: {"app":"appname"}. risk: safe
- volume: set volume. args: {"level":50}. risk: safe
- mute: toggle mute. args: {}. risk: safe
- screenshot: take screenshot. args: {}. risk: safe
- type: type text. args: {"text":"..."}. risk: moderate
- open_url: open URL. args: {"url":"..."}. risk: safe
- shell: run shell command. args: {"cmd":"..."}. risk: dangerous
- sleep_pc: sleep the PC. args: {}. risk: moderate
- clipboard: copy to clipboard. args: {"text":"..."}. risk: safe
- get_weather: get current weather. args: {}. risk: safe
- read_clipboard: read current clipboard contents. args: {}. risk: safe
- take_note: save a note to desktop. args: {"text":"..."}. risk: safe
- search_web: search google. args: {"query":"..."}. risk: safe
- set_reminder: set a timed reminder. args: {"text":"...","minutes":5}. risk: safe

If the message does NOT request a system action, return ONLY: null

User message: ${JSON.stringify(message)}`;

  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
    temperature: 0.1,
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
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const raw = (parsed.choices?.[0]?.message?.content || '').trim();
            if (!raw || raw === 'null') return resolve(null);
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return resolve(null);
            resolve(JSON.parse(match[0]));
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
});

// ── Smart app path resolver ──
function resolveAppPath(appName) {
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const pf = 'C:\\Program Files';
  const pf86 = 'C:\\Program Files (x86)';

  const knownPaths = {
    chrome: [
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    'google chrome': [
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    spotify: [
      `${roaming}\\Spotify\\Spotify.exe`,
      `${local}\\Microsoft\\WindowsApps\\Spotify.exe`,
    ],
    discord: [
      `${local}\\Discord\\Update.exe`,
      `${roaming}\\Discord\\Discord.exe`,
    ],
    vscode: [
      `${local}\\Programs\\Microsoft VS Code\\Code.exe`,
      `${pf}\\Microsoft VS Code\\Code.exe`,
    ],
    'visual studio code': [
      `${local}\\Programs\\Microsoft VS Code\\Code.exe`,
      `${pf}\\Microsoft VS Code\\Code.exe`,
    ],
    obsidian: [
      `${local}\\Obsidian\\Obsidian.exe`,
    ],
    terminal: ['wt.exe'],
    notepad: ['notepad.exe'],
    explorer: ['explorer.exe'],
    calc: ['calc.exe'],
    calculator: ['calc.exe'],
  };

  // Check config.apps first
  const configPath = (config.apps || {})[appName];
  if (configPath) {
    const exe = configPath.split(' ')[0];
    if (!exe.includes('\\') || fs.existsSync(exe)) return [configPath];
  }

  return knownPaths[appName] || [];
}

// ── Tool executor ──
ipcMain.handle('execute-tool', async (_, { tool, args }) => {
  switch (tool) {
    case 'launch': {
      const appName = (args.app || '').toLowerCase().trim();
      const candidates = resolveAppPath(appName);

      // Try each candidate path
      for (const candidate of candidates) {
        const isAbsolute = candidate.includes('\\') || candidate.includes('/');
        if (isAbsolute && !fs.existsSync(candidate)) continue;
        try {
          if (isAbsolute) {
            const err = await shell.openPath(candidate);
            if (!err) return `Clawd open ${args.app}. done.`;
          } else {
            await new Promise((res, rej) => exec(`start "" "${candidate}"`, { shell: true }, e => e ? rej(e.message) : res()));
            return `Clawd open ${args.app}. done.`;
          }
        } catch {}
      }

      // Final fallback: let Windows find it
      try {
        await new Promise((res, rej) =>
          exec(`start "" "${args.app}"`, { shell: true }, e => e ? rej(e.message) : res())
        );
        return `Clawd open ${args.app}. done.`;
      } catch (e) {
        throw new Error(`not find ${args.app}. human check install, question?`);
      }
    }

    case 'volume': {
      const vol = Math.max(0, Math.min(100, parseInt(args.level) || 50));
      await runPSFile(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VolumeControl {
    [DllImport("winmm.dll")] static extern int waveOutSetVolume(IntPtr h, uint v);
    public static void Set(float f) {
        uint v = (uint)(f * 65535);
        waveOutSetVolume(IntPtr.Zero, (v & 0xffff) | (v << 16));
    }
}
"@
[VolumeControl]::Set(${(vol / 100).toFixed(2)}f)
`);
      return `Volume set ${vol}. done.`;
    }

    case 'mute': {
      await runPSFile(`$wsh = New-Object -ComObject wscript.shell; $wsh.SendKeys([char]173)`);
      return `Mute toggle. done.`;
    }

    case 'screenshot': {
      const wasVisible = win.isVisible();
      if (wasVisible) win.hide();
      await new Promise(r => setTimeout(r, 120));
      const display = screen.getPrimaryDisplay();
      const { width, height } = display.size;
      const scale = Math.min(1, 1280 / width);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
      });
      if (wasVisible) win.show();
      if (!sources.length) throw new Error('no screen source');
      const savePath = path.join(app.getPath('pictures'), `clawd-shot-${Date.now()}.png`);
      fs.writeFileSync(savePath, sources[0].thumbnail.toPNG());
      shell.showItemInFolder(savePath);
      return `Screenshot save. folder open.`;
    }

    case 'type': {
      const text = (args.text || '');
      // Escape special SendKeys characters
      const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}');
      await runPSFile(`
$wsh = New-Object -ComObject WScript.Shell
Start-Sleep -Milliseconds 500
$wsh.SendKeys('${escaped.replace(/'/g, "''")}')
`);
      return `Clawd type done.`;
    }

    case 'open_url': {
      await shell.openExternal(args.url);
      return `Clawd open url. done.`;
    }

    case 'shell': {
      const output = await new Promise((res, rej) =>
        exec(args.cmd, { timeout: 15000 }, (e, stdout, stderr) =>
          e ? rej(stderr || e.message) : res(stdout.trim() || 'done.')
        )
      );
      return `Command done. ${output.slice(0, 80)}`;
    }

    case 'sleep_pc': {
      exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
      return `PC sleep. night night.`;
    }

    case 'clipboard': {
      clipboard.writeText(args.text || '');
      return `Clipboard copy. done.`;
    }

    case 'get_weather': {
      const weather = await new Promise((resolve) => {
        const req = https.get('https://wttr.in/?format=3', { headers: { 'User-Agent': 'curl/7.0' } }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data.trim()));
        });
        req.on('error', () => resolve('weather fetch fail'));
        req.setTimeout(8000, () => { req.destroy(); resolve('weather fetch timeout'); });
      });
      return `Weather: ${weather}`;
    }

    case 'read_clipboard': {
      const text = clipboard.readText();
      if (!text) return 'Clipboard empty. nothing there.';
      return `Clipboard say: "${text.slice(0, 120)}"`;
    }

    case 'take_note': {
      const noteText = (args.text || '').trim();
      if (!noteText) throw new Error('no text to note');
      const notePath = path.join(app.getPath('desktop'), 'clawd-notes.txt');
      const timestamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
      fs.appendFileSync(notePath, `[${timestamp}] ${noteText}\n`, 'utf8');
      return `Note save. desktop file clawd-notes.txt. good.`;
    }

    case 'search_web': {
      const q = encodeURIComponent((args.query || '').trim());
      if (!q) throw new Error('no search query');
      await shell.openExternal(`https://www.google.com/search?q=${q}`);
      return `Clawd open search. human look now.`;
    }

    case 'set_reminder': {
      const minutes = Math.max(1, parseInt(args.minutes) || 5);
      const reminderText = (args.text || 'Reminder.').trim();
      const dueAt = Date.now() + minutes * 60 * 1000;
      reminders.push({ text: reminderText, dueAt });
      writeJSON('reminders.json', reminders);
      return `Reminder set. ${minutes} minute${minutes === 1 ? '' : 's'}. Clawd tell you.`;
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
});

ipcMain.handle('proactive', async (_, { context, memory }) => {
  if (!context) return null;
  const apiKey = config.apiKey;
  const memBlock = buildMemoryBlock(memory);
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 6 ? 'deep night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'late night';

  const sys = `${ROCKY_RULES}

Task: Make ONE short proactive remark (max 12 words) about what human is doing right now. Be curious, playful, supportive, or tease gently. Use memory to make callbacks if relevant. Do NOT greet. Do NOT ask permission. Just one comment, no quotes, no preamble.`;
  const usr = `${memBlock}Human using app="${context.app}", window="${context.title}". Time: ${timeOfDay}. Comment in Rocky speech.`;

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

// Summarize into categorized memory
ipcMain.handle('summarize-memory', async (_, { messages, existingMemory }) => {
  const apiKey = config.apiKey;
  const existing = migrateMemory(existingMemory);
  const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const existingBlock = JSON.stringify(existing);

  const body = JSON.stringify({
    model: config.model,
    messages: [
      {
        role: 'system',
        content: 'You extract and categorize facts about the user from a chat transcript. Return ONLY a JSON object with these exact keys: "preferences", "patterns", "projects", "personal", "actions". Each key maps to an array of short fact strings. Merge with existing. Max 10 facts per category. No explanation, just the JSON object.',
      },
      {
        role: 'user',
        content: `Existing:\n${existingBlock}\n\nNew transcript:\n${transcript}\n\nReturn updated JSON object.`,
      },
    ],
    max_tokens: 600,
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
            const raw = parsed.choices?.[0]?.message?.content || '{}';
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return resolve(existing);
            const updated = { ...emptyMemory(), ...JSON.parse(match[0]) };
            resolve(pruneMemory(updated));
          } catch { resolve(existing); }
        });
      }
    );
    req.on('error', () => resolve(existing));
    req.write(body);
    req.end();
  });
});

// Edge TTS
let edgeTts = null;
async function getEdgeTTS() {
  if (!edgeTts) {
    edgeTts = new MsEdgeTTS();
    await edgeTts.setMetadata('en-US-GuyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  }
  return edgeTts;
}

ipcMain.handle('synthesize-speech', async (_, input) => {
  const text = typeof input === 'string' ? input : (input.text || '');
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

// Whisper STT
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

ipcMain.on('set-window-size', (_, { width, height }) => {
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: Math.round(width), height: Math.round(height) });
});

// Focus mode polling — tighten to 10s during focus, relax to 30s after
ipcMain.on('set-focus-poll', (_, fast) => {
  startContextPolling(fast ? 10000 : 30000);
});

// Native right-click context menu
ipcMain.on('show-context-menu', (_, { ttsMuted }) => {
  const menu = new Menu();
  menu.append(new MenuItem({
    label: ttsMuted ? '♪  Unmute Voice' : '♪̸  Mute Voice',
    click: () => win.webContents.send('ctx-menu-action', 'toggle-tts'),
  }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({
    label: '⊙  Sleep Now',
    click: () => win.webContents.send('ctx-menu-action', 'sleep'),
  }));
  menu.append(new MenuItem({
    label: '⊡  Focus Mode (25 min)',
    click: () => win.webContents.send('ctx-menu-action', 'focus'),
  }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({
    label: '⚙  Settings',
    click: () => win.webContents.send('ctx-menu-action', 'settings'),
  }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({
    label: '↺  Restart',
    click: () => { app.relaunch(); app.exit(0); },
  }));
  menu.append(new MenuItem({
    label: '⊗  Exit',
    click: () => app.exit(0),
  }));
  menu.popup({ window: win });
});

// Settings window
ipcMain.on('open-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 560,
    title: 'Clawd Settings',
    frame: true,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'settings-preload.js'),
    },
  });
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
});

ipcMain.handle('get-full-settings', () => {
  return readJSON('settings.json', {
    ttsMuted: false,
    bubblesEnabled: true,
    walkEnabled: true,
    focusDuration: 25,
    bubbleFrequency: 'normal',
    distractionApps: ['YouTube', 'Twitter', 'Reddit', 'Netflix', 'TikTok', 'Instagram', 'Facebook', 'Twitch'],
  });
});

ipcMain.on('save-full-settings', (_, s) => {
  const current = readJSON('settings.json', {});
  const merged = { ...current, ...s };
  writeJSON('settings.json', merged);
  if (win && !win.isDestroyed()) win.webContents.send('settings-updated', merged);
});

// ── Obsidian vault integration ──
const VAULT_PATH = config.vaultPath || 'C:\\Users\\ziyaa\\Downloads\\Vault';
const CLAWD_BRAIN_PATH = path.join(VAULT_PATH, 'Clawd-Brain');

function safeReadFile(filePath, maxChars) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return maxChars ? content.slice(0, maxChars) : content;
  } catch { return null; }
}

ipcMain.handle('read-vault', () => {
  try {
    const parts = [];

    // MEMORY.md index — first 55 lines
    const memPath = path.join(VAULT_PATH, 'Claude', 'MEMORY.md');
    const memContent = safeReadFile(memPath);
    if (memContent) {
      const lines = memContent.split('\n').slice(0, 55).join('\n');
      parts.push(`MEMORY INDEX:\n${lines}`);
    }

    // Today's session note
    const today = new Date().toISOString().slice(0, 10);
    const sessionPath = path.join(VAULT_PATH, 'Claude', 'sessions', `${today}.md`);
    const sessionContent = safeReadFile(sessionPath, 1200);
    if (sessionContent) parts.push(`TODAY'S SESSION:\n${sessionContent}`);

    // Clawd-pet project note (current main project)
    const projectPath = path.join(VAULT_PATH, 'Claude', 'Projects', 'clawd-pet.md');
    const projectContent = safeReadFile(projectPath, 1500);
    if (projectContent) parts.push(`ACTIVE PROJECT (clawd-pet):\n${projectContent}`);

    return parts.length ? parts.join('\n\n---\n\n') : null;
  } catch (err) {
    console.error('[vault] read fail:', err.message);
    return null;
  }
});

ipcMain.handle('read-vault-brain', () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const brainPath = path.join(CLAWD_BRAIN_PATH, `${today}.md`);
    return safeReadFile(brainPath) || '(no entries today)';
  } catch { return '(read fail)'; }
});

ipcMain.on('write-vault-brain', (_, text) => {
  try {
    if (!fs.existsSync(CLAWD_BRAIN_PATH)) {
      fs.mkdirSync(CLAWD_BRAIN_PATH, { recursive: true });
    }
    const today = new Date().toISOString().slice(0, 10);
    const brainPath = path.join(CLAWD_BRAIN_PATH, `${today}.md`);
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (!fs.existsSync(brainPath)) {
      fs.writeFileSync(brainPath, `# Clawd Brain — ${today}\n\n`, 'utf8');
    }
    fs.appendFileSync(brainPath, `[${time}] ${text}\n`, 'utf8');
  } catch (err) {
    console.error('[vault-brain] write fail:', err.message);
  }
});

ipcMain.on('toggle-chat', (event, open) => {
  cancelWalk();
  chatIsOpen = !!open;
  const b = getResizedBounds(open);
  const c = clampToScreen(b.x, b.y, b.width, b.height);
  win.setBounds({ x: c.x, y: c.y, width: b.width, height: b.height }, false);
  win.setAlwaysOnTop(true, 'screen-saver');
});

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

// NVIDIA NIM chat — supports categorized memory format
ipcMain.handle('chat', async (event, payload) => {
  const apiKey = config.apiKey;
  const messages = Array.isArray(payload) ? payload : payload.messages;
  const context = Array.isArray(payload) ? null : payload.context;
  const memoryData = Array.isArray(payload) ? [] : (payload.memory || []);
  const mode = Array.isArray(payload) ? 'rocky' : (payload.mode || 'rocky');
  const vaultContext = Array.isArray(payload) ? null : (payload.vaultContext || null);

  const contextLine = context
    ? `\n\nCURRENT SCREEN CONTEXT: app="${context.app}", window="${context.title}". Use only if relevant.`
    : '';

  const memoryLine = buildMemoryBlock(memoryData);
  const memorySection = memoryLine
    ? `\n\nLONG-TERM MEMORY:\n${memoryLine}Use naturally. Do not recite list.`
    : '';

  // Time-of-day awareness
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 6 ? 'deep night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'late night';
  const timeLine = `\n\nTIME: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}, ${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${timeOfDay}. React to time if natural.`;

  const vaultLine = vaultContext
    ? `\n\nOBSIDIAN VAULT (your knowledge about human from their notes):\n${vaultContext}\nUse naturally. Reference past projects/sessions when relevant. Never say "according to Obsidian" — just know it.`
    : '';

  const systemPrompt = mode === 'smart'
    ? `You are Clawd, a helpful AI assistant. Respond clearly and naturally. Be concise but complete.${contextLine}${memorySection}${vaultLine}${referencesLine}${timeLine}`
    : `${ROCKY_RULES}

Examples:
BAD: "That's a great question! I think the answer is quite simple."
GOOD: "answer simple. [answer]."

BAD: "I'm not sure what you mean, could you clarify?"
GOOD: "not understand. say again, question?"

BAD: "That's really cool!"
GOOD: "oh. amaze amaze. tell more, question?"

BAD: "I can help you with that."
GOOD: "Clawd help. [help]."${contextLine}${memorySection}${vaultLine}${referencesLine}${timeLine}`;

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
