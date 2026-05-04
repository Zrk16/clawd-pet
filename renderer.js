const pet = document.getElementById('pet');
document.documentElement.style.zoom = 'reset';
document.getElementById('restart-btn').addEventListener('click', () => window.clawd.restart());
const petImg = document.getElementById('pet-img');
const chatPanel = document.getElementById('chat-panel');
const messagesEl = document.getElementById('messages');
const input = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const ttsBtn = document.getElementById('tts-btn');
const micBtn = document.getElementById('mic-btn');

// ── UI Preset system ──
const PRESETS = ['og', 'crt', 'gameboy', 'vhs', 'dos', 'synthwave', 'midnight', 'grimoire', 'ink', 'paper', 'nordic', 'neon-punk', 'comic-book', 'memphis', 'silkscreen', 'marshmallow', 'liquid-glass', 'minimal', 'neon', 'retro', 'botanical', 'ocean', 'sunset', 'monochrome', 'pastel', 'gradient', 'material', 'flat', 'glass-dark', 'neubrutalism', 'terminal', 'skeleton', 'vaporwave', 'space', 'wood', 'holographic'];
let currentPresetLink = null;

function applyUiPreset(preset) {
  document.body.classList.remove(...PRESETS.map(p => 'preset-' + p));
  document.body.classList.add('preset-' + preset);
  if (!currentPresetLink) {
    currentPresetLink = document.createElement('link');
    currentPresetLink.rel = 'stylesheet';
    document.head.appendChild(currentPresetLink);
  }
  currentPresetLink.href = preset + '.css';
}

(async () => {
  const settings = await window.clawd.loadSettings();
  applyUiPreset(settings.uiPreset || 'og');
})();

window.clawd.onSettingsUpdated((settings) => {
  applyUiPreset(settings.uiPreset || 'og');
});

let history = [];
let memoryCats = { preferences: [], patterns: [], projects: [], personal: [], actions: [] };
let chatOpen = false;
let speechMode = 'rocky';
let idleTimer = null;
let idleCycleTimer = null;
let currentContext = null;
let messagesSinceLastSummarize = 0;
const SUMMARIZE_EVERY = 10;
let wakeEnabled = false;
let currentMood = 'idle';

// ── Obsidian vault context ──
let vaultContext = null;

async function refreshVault() {
  try {
    vaultContext = await window.clawd.readVault();
    console.log('[vault] loaded:', vaultContext ? vaultContext.length + ' chars' : 'empty');
  } catch (err) {
    console.error('[vault] init fail:', err);
  }
}
refreshVault();
setInterval(refreshVault, 30 * 60 * 1000); // refresh every 30 min

// ── Focus / Pomodoro state ──
let focusMode = false;
let focusEndTime = null;
let focusTimerInterval = null;
let focusSessions = 0;
let focusStartTime = null;
const focusTimerEl = document.getElementById('focus-timer');

// ── Distraction apps (loaded from settings) ──
let distractionApps = ['YouTube', 'Twitter', 'Reddit', 'Netflix', 'TikTok', 'Instagram', 'Facebook', 'Twitch'];
let lastDistractionAt = 0;


async function initMemory() {
  history = await window.clawd.loadHistory();
  const raw = await window.clawd.loadMemory();
  // Handle both legacy array and new categorized format
  if (Array.isArray(raw)) {
    memoryCats = { preferences: [], patterns: [], projects: [], personal: raw, actions: [] };
  } else {
    memoryCats = { preferences: [], patterns: [], projects: [], personal: [], actions: [], ...raw };
  }
}

initMemory();

// ── First open of day ──
async function checkFirstOpen() {
  try {
    const { isFirstToday } = await window.clawd.checkFirstOpen();
    if (isFirstToday) {
      setTimeout(() => showBubble('new day. Clawd wake. human here, question? good good.'), 5000);
    }
  } catch {}
}
checkFirstOpen();

// ── TTS ──
let ttsMuted = false;
let audioCtx = null;
let activeSources = [];

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  return audioCtx;
}

function stopCurrentSpeech() {
  activeSources.forEach(s => { try { s.stop(); } catch {} });
  activeSources = [];
}

async function speak(text, mood) {
  if (ttsMuted || !text) return;
  stopCurrentSpeech();
  try {
    const b64 = await window.clawd.synthesizeSpeech(text, mood || currentMood);
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const audioBuf = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    src.start();
    activeSources.push(src);
  } catch (err) {
    console.error('[speak] fail:', err.message);
  }
}

async function initTtsState() {
  const settings = await window.clawd.loadSettings();
  ttsMuted = !!settings.ttsMuted;
  updateTtsBtn();
  if (Array.isArray(settings.distractionApps)) distractionApps = settings.distractionApps;
}

function saveAllSettings() {
  window.clawd.saveSettings({ ttsMuted, wakeWordEnabled: wakeEnabled, distractionApps });
}

function updateTtsBtn() {
  ttsBtn.classList.toggle('muted', ttsMuted);
  ttsBtn.textContent = ttsMuted ? '♪̸' : '♪';
  ttsBtn.title = ttsMuted ? 'Voice off — click to enable' : 'Voice on — click to mute';
}

ttsBtn.addEventListener('click', () => {
  ttsMuted = !ttsMuted;
  if (ttsMuted) stopCurrentSpeech();
  updateTtsBtn();
  saveAllSettings();
});

initTtsState();

// ── Mode toggle ──
const modeBtn = document.getElementById('mode-btn');

function setMode(m) {
  speechMode = m;
  modeBtn.textContent = `/${m}`;
  modeBtn.classList.toggle('smart', m === 'smart');
}

modeBtn.addEventListener('click', () => setMode(speechMode === 'rocky' ? 'smart' : 'rocky'));

// ── Copy last response ──
document.getElementById('copy-btn').addEventListener('click', () => {
  const msgs = document.querySelectorAll('.msg-text');
  if (!msgs.length) return;
  const last = msgs[msgs.length - 1].innerText;
  navigator.clipboard.writeText(last).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⎘'; }, 1200);
  });
});

// ── STT (Whisper) ──
let srMode = 'idle';
let micStream = null;
let micAudioCtx = null;
let micProcessor = null;
let audioChunks = [];

window.clawd.onSttStatus((status) => {
  if (status === 'loading') input.value = 'Loading voice model (first time ~150MB)...';
  else if (status === 'error') input.value = 'Voice model failed to load.';
  else if (status === 'ready') input.value = '';
});

async function startCommand() {
  srMode = 'command';
  audioChunks = [];
  micBtn.classList.add('listening');
  stopCurrentSpeech();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    micAudioCtx = new AudioContext({ sampleRate: 16000 });
    const source = micAudioCtx.createMediaStreamSource(micStream);
    micProcessor = micAudioCtx.createScriptProcessor(4096, 1, 1);
    micProcessor.onaudioprocess = (e) => {
      audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(micProcessor);
    micProcessor.connect(micAudioCtx.destination);
  } catch (err) {
    console.error('[mic] fail:', err.message);
    srMode = 'idle';
    micBtn.classList.remove('listening');
  }
}

async function stopCommandAndSend() {
  if (srMode !== 'command') return;
  srMode = 'idle';
  micBtn.classList.remove('listening');
  if (micProcessor) { micProcessor.disconnect(); micProcessor = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (micAudioCtx) { await micAudioCtx.close(); micAudioCtx = null; }

  const total = audioChunks.reduce((n, c) => n + c.length, 0);
  if (total === 0) return;

  const merged = new Float32Array(total);
  let off = 0;
  for (const c of audioChunks) { merged.set(c, off); off += c.length; }
  audioChunks = [];

  input.value = 'transcribing...';
  micBtn.disabled = true;
  const text = await window.clawd.sttTranscribe(merged.buffer);
  micBtn.disabled = false;
  if (text) { input.value = text; sendMessage(); }
  else input.value = '';
}

micBtn.addEventListener('click', () => {
  if (srMode === 'command') stopCommandAndSend();
  else startCommand();
});

// ── Global hotkey handler ──
window.clawd.onHotkeyAction((action) => {
  if (action === 'open') {
    // keydown fires — will resolve to tap or hold, do nothing yet
  } else if (action === 'tap') {
    // Short press: toggle chat
    if (chatOpen) closeChat();
    else { openChat(); setTimeout(() => input.focus(), 100); }
  } else if (action === 'hold-start') {
    if (!chatOpen) {
      openChat();
      setTimeout(() => startCommand(), 350);
    } else {
      startCommand();
    }
  } else if (action === 'hold-end') {
    stopCommandAndSend();
  }
});

// ── Same-app 20min proactive notify ──
window.clawd.onSameAppNotify((ctx) => {
  if (!chatOpen && !bubbleVisible) fireProactive();
});

// ── App name → mood map ──
const APP_MOODS = {
  'Code.exe': 'coding',
  'devenv.exe': 'coding',
  'WindowsTerminal.exe': 'coding',
  'cmd.exe': 'coding',
  'powershell.exe': 'coding',
  'chrome.exe': 'thinking',
  'firefox.exe': 'thinking',
  'msedge.exe': 'thinking',
  'Spotify.exe': 'happy',
  'Discord.exe': 'excited',
  'obsidian.exe': 'thinking',
};

let lastContextRemarkAt = 0;

// ── Focus mode functions ──
function startFocus(minutes) {
  minutes = minutes || 25;
  focusMode = true;
  focusStartTime = Date.now();
  focusEndTime = Date.now() + minutes * 60 * 1000;
  setSvg('coding');
  document.getElementById('pet-container').classList.add('focus-active');
  stopWalking();
  clearTimeout(proactiveTimer);
  window.clawd.setFocusPoll(true);
  focusTimerEl.classList.remove('hidden');
  showBubble(`focus start. ${minutes} minute. Clawd watch. no distract.`);
  clearInterval(focusTimerInterval);
  focusTimerInterval = setInterval(() => {
    const remaining = focusEndTime - Date.now();
    if (remaining <= 0) {
      endFocus();
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      focusTimerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

function endFocus() {
  if (!focusMode) return;
  focusMode = false;
  clearInterval(focusTimerInterval);
  focusTimerInterval = null;
  focusTimerEl.classList.add('hidden');
  document.getElementById('pet-container').classList.remove('focus-active');
  focusSessions++;
  const minutesDone = Math.round((Date.now() - focusStartTime) / 60000);
  window.clawd.setFocusPoll(false);
  setSvg('happy');
  showBubble(`focus complete. ${minutesDone} minute. good good. rest now.`);
  setTimeout(() => startProactiveLoop(), 5000);
  setTimeout(() => startWalking(), 5000);
}

function cancelFocus() {
  if (!focusMode) return;
  focusMode = false;
  clearInterval(focusTimerInterval);
  focusTimerInterval = null;
  focusTimerEl.classList.add('hidden');
  document.getElementById('pet-container').classList.remove('focus-active');
  window.clawd.setFocusPoll(false);
  showBubble('focus cancel. ok. Clawd understand.');
  startProactiveLoop();
  startWalking();
}

function flashDistraction() {
  document.getElementById('pet-container').classList.add('distraction-flash');
  setTimeout(() => {
    document.getElementById('pet-container').classList.remove('distraction-flash');
    if (focusMode) setSvg('coding');
  }, 700);
}

window.clawd.onContextChange((ctx) => {
  currentContext = ctx;

  // Distraction detection during focus
  if (focusMode) {
    const haystack = (ctx.title + ' ' + ctx.app).toLowerCase();
    const isDistraction = distractionApps.some(d => haystack.includes(d.toLowerCase()));
    const now = Date.now();
    if (isDistraction && now - lastDistractionAt > 30000) {
      lastDistractionAt = now;
      flashDistraction();
      const name = ctx.app || 'that';
      showBubble(`Goodos. ${name} not focus. back. now.`);
    }
    return; // skip mood + proactive during focus
  }

  if (!chatOpen && petImg.src && !petImg.src.includes('sleeping')) {
    const mood = APP_MOODS[ctx.app];
    if (mood) {
      setSvg(mood);
      resetSleepTimer();
    }
  }
  const now = Date.now();
  if (!chatOpen && !bubbleVisible && now - lastContextRemarkAt > 90000 && Math.random() < 0.25) {
    lastContextRemarkAt = now;
    fireProactive();
  }
});

// ── Reminder handler ──
window.clawd.onReminderFire((text) => {
  showBubble(`reminder: ${text}`);
  speak(text, 'excited');
});

// ── Settings updated handler ──
window.clawd.onSettingsUpdated((s) => {
  if (typeof s.ttsMuted === 'boolean') { ttsMuted = s.ttsMuted; updateTtsBtn(); }
  if (Array.isArray(s.distractionApps)) distractionApps = s.distractionApps;
});

// ── Context menu action handler ──
window.clawd.onCtxMenuAction((action) => {
  switch (action) {
    case 'toggle-tts':
      ttsMuted = !ttsMuted;
      if (ttsMuted) stopCurrentSpeech();
      updateTtsBtn();
      saveAllSettings();
      break;
    case 'sleep':
      setSvg('sleeping');
      stopIdleCycle();
      showBubble('Clawd sleep now. tap to wake.');
      break;
    case 'focus':
      if (focusMode) cancelFocus();
      else startFocus(25);
      break;
    case 'settings':
      window.clawd.openSettings();
      break;
  }
});

// ── SVG mood map ──
const MOODS = {
  idle: [
    'artboard-24cla.svg', 'artboard-24cla2.svg', 'artboard-24cla3.svg',
    'artboard-25cla.svg', 'artboard-2cla.svg', 'artboard-3cla.svg',
    'artboard-4cla.svg', 'in-glowing-aura.svg',
  ],
  thinking: [
    'thinking-in-code.svg', 'thinking-pixel-bubble.svg',
    'processing-logic-symbols.svg', 'reading-data-document.svg',
  ],
  happy: [
    'happy-pixel-celebrating.svg', 'with-success-checkmark.svg',
    'rocket-launch-success.svg', 'love-cloud-pixel.svg',
    'success-achievement-milestone.svg',
  ],
  error: [
    'error-state-pixel.svg', 'dizzy-failed-state.svg',
    'marking-critical-error.svg', 'broken-heart-sad.svg',
  ],
  greeting: [
    'welcome-pixel-banner.svg', 'happy-pixel-celebrating.svg',
  ],
  coding: [
    'writing-software-code.svg', 'debugging-system-bugs.svg',
    'idea-lightbulb-pixel.svg', 'data-blocks-pixel.svg',
  ],
  confused: [
    'confusion-spiral-pixel.svg', 'it-depends-sign.svg',
    'dizzy-failed-state.svg',
  ],
  excited: [
    'rocket-launch-success.svg', 'trending-up-pixel.svg',
    'api-success-pixel.svg', 'idea-lightbulb-pixel.svg',
  ],
  sleeping: ['sleeping-soundly.svg'],
};

const KEYWORD_MOODS = [
  { mood: 'error',   words: ['error', 'fail', 'broke', 'wrong', 'sorry', 'not work', 'cannot'] },
  { mood: 'excited', words: ['interesting', 'cool', 'neat', 'wow', 'amazing', 'great', 'excellent'] },
  { mood: 'coding',  words: ['code', 'build', 'debug', 'function', 'program', 'write', 'script'] },
  { mood: 'confused',words: ['hmm', 'maybe', 'depend', 'wonder', 'not sure', 'unclear', 'perhaps'] },
];

function pickSvg(mood) {
  const list = MOODS[mood] || MOODS.idle;
  return 'assets/' + list[Math.floor(Math.random() * list.length)];
}

function setSvg(mood) {
  currentMood = mood;
  const src = pickSvg(mood);
  if (petImg.src.endsWith(src)) return;
  petImg.classList.remove('bounce-in', 'swapping');
  void petImg.offsetWidth;
  petImg.src = src;
  petImg.classList.add('bounce-in');
  petImg.addEventListener('animationend', () => {
    petImg.classList.remove('bounce-in');
  }, { once: true });
}

function detectMood(text) {
  const lower = text.toLowerCase();
  for (const { mood, words } of KEYWORD_MOODS) {
    if (words.some(w => lower.includes(w))) return mood;
  }
  return 'happy';
}

// ── Idle cycling ──
function startIdleCycle() {
  clearInterval(idleCycleTimer);
  idleCycleTimer = setInterval(() => setSvg('idle'), 10000);
}

function stopIdleCycle() {
  clearInterval(idleCycleTimer);
}

// ── Proactive bubbles ──
const bubble = document.getElementById('bubble');
let bubbleVisible = false;
let bubbleHideTimer = null;
let proactiveTimer = null;
let confirmResolve = null;
const PROACTIVE_MIN_MS = 3 * 60 * 1000;
const PROACTIVE_MAX_MS = 8 * 60 * 1000;

function showBubble(text) {
  if (!text || chatOpen) return;
  bubble.textContent = text;
  bubbleVisible = true;
  stopWalking();
  window.clawd.toggleBubble(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => bubble.classList.remove('hidden'));
  });
  speak(text);
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(hideBubble, 8000);
}

function hideBubble() {
  if (!bubbleVisible) return;
  bubbleVisible = false;
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  bubble.classList.add('hidden');
  clearTimeout(bubbleHideTimer);
  setTimeout(() => {
    if (!bubbleVisible && !chatOpen) {
      window.clawd.toggleBubble(false);
      startWalking();
    }
  }, 320);
}

bubble.addEventListener('click', (e) => {
  // Don't close if clicking confirm buttons
  if (e.target.classList.contains('confirm-btn')) return;
  hideBubble();
  if (!confirmResolve) pet.click();
});

async function fireProactive() {
  if (chatOpen || bubbleVisible || !currentContext) return;
  try {
    const remark = await window.clawd.proactive(currentContext, memoryCats);
    if (remark) showBubble(remark);
  } catch {}
}

function startProactiveLoop() {
  clearTimeout(proactiveTimer);
  const gap = PROACTIVE_MIN_MS + Math.random() * (PROACTIVE_MAX_MS - PROACTIVE_MIN_MS);
  proactiveTimer = setTimeout(async () => {
    await fireProactive();
    startProactiveLoop();
  }, gap);
}

// ── Tool confirm bubble ──
function confirmTool(tool, args, isDangerous = false) {
  return new Promise((resolve) => {
    if (bubbleVisible) hideBubble();
    confirmResolve = resolve;
    const msg = isDangerous
      ? `Clawd run ${tool}: ${JSON.stringify(args)}. dangerous. do, question?`
      : `Clawd do ${tool}. ok, question?`;
    bubble.innerHTML = `<div>${msg}</div><div style="margin-top:6px;display:flex;gap:8px"><button class="confirm-btn" id="cb-yes">yes.</button><button class="confirm-btn" id="cb-no">no.</button></div>`;
    bubbleVisible = true;
    window.clawd.toggleBubble(true);
    requestAnimationFrame(() => requestAnimationFrame(() => bubble.classList.remove('hidden')));

    document.getElementById('cb-yes').onclick = () => {
      hideBubble();
      if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
    };
    document.getElementById('cb-no').onclick = () => {
      hideBubble();
      if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
    };
  });
}

// ── Idle walk ──
let walkTimer = null;
let homeX = null;
let homeY = null;
const WALK_RADIUS = 150;

async function startWalking() {
  if (walkTimer) return;

  const tick = async () => {
    if (chatOpen || bubbleVisible) return stopWalking();
    const pos = await window.clawd.getWindowPos();
    const { x, y, screenMinX, screenMaxX } = pos;

    if (homeX === null) { homeX = x; homeY = y; }

    const homeLeft = Math.max(screenMinX, homeX - WALK_RADIUS);
    const homeRight = Math.min(screenMaxX, homeX + WALK_RADIUS);
    const targetX = homeLeft + Math.random() * (homeRight - homeLeft);

    const duration = 2500 + Math.random() * 2500;
    window.clawd.walkTo(targetX, homeY, duration);
    walkTimer = setTimeout(tick, duration + 1500 + Math.random() * 4000);
  };
  walkTimer = setTimeout(tick, 5000);
}

function stopWalking() {
  clearTimeout(walkTimer);
  walkTimer = null;
  window.clawd.cancelWalk();
}

function resetWalkHome() {
  homeX = null;
  homeY = null;
  stopWalking();
}

// ── Sleep after 5 min idle ──
function resetSleepTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    setSvg('sleeping');
    stopIdleCycle();
  }, 5 * 60 * 1000);
}

// ── Drag (Ctrl + mousedown) ──
let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let pendingDragX = null;
let pendingDragY = null;
let dragRafId = null;
let justDragged = false;

function flushDrag() {
  dragRafId = null;
  if (pendingDragX !== null) {
    window.clawd.moveWindow(pendingDragX, pendingDragY);
    pendingDragX = pendingDragY = null;
  }
}

pet.addEventListener('mousedown', async (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  dragging = true;
  const pos = await window.clawd.getWindowPos();
  dragOffsetX = e.screenX - pos.x;
  dragOffsetY = e.screenY - pos.y;
  pet.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  pendingDragX = e.screenX - dragOffsetX;
  pendingDragY = e.screenY - dragOffsetY;
  if (dragRafId === null) dragRafId = requestAnimationFrame(flushDrag);
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  justDragged = true;
  pet.style.cursor = '';
  resetWalkHome();
  setTimeout(() => { justDragged = false; }, 50);
});

// ── Chat open/close helpers ──
function openChat() {
  if (chatOpen) return;
  chatOpen = true;
  window.clawd.sendChatOpen(true);
  resetSleepTimer();
  stopWalking();
  hideBubble();
  window.clawd.toggleChat(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chatPanel.classList.remove('hidden');
      input.focus();
    });
  });
  if (history.length === 0) setSvg('greeting');
  else setSvg('idle');
  stopIdleCycle();
}

function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  window.clawd.sendChatOpen(false);
  chatPanel.classList.add('hidden');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.clawd.toggleChat(false);
    });
  });
  startIdleCycle();
  startWalking();
}

// ── Toggle chat (click pet) ──
pet.addEventListener('click', (e) => {
  if (e.ctrlKey || justDragged) return;
  if (chatOpen) closeChat();
  else openChat();
});

// ── Right-click → native context menu ──
pet.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.clawd.showContextMenu({ ttsMuted });
});

// ── Settings button ──
document.getElementById('settings-btn').addEventListener('click', () => {
  window.clawd.openSettings();
});

// ── Send message ──
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  if (text === '/ctx') {
    input.value = '';
    const data = await window.clawd.debugContext();
    appendMessage('clawd', `RAW: ${JSON.stringify(data, null, 2)}`);
    return;
  }

  if (text === '/exit' || text === '/quit') {
    input.value = '';
    appendMessage('clawd', 'Clawd sleep. bye bye.');
    setTimeout(() => window.clawd.quit(), 400);
    return;
  }

  if (text === '/restart') {
    input.value = '';
    appendMessage('clawd', 'Clawd reboot. brain reset.');
    setTimeout(() => window.clawd.restart(), 400);
    return;
  }

  if (text === '/smart') {
    input.value = '';
    setMode('smart');
    appendMessage('clawd', 'Smart mode. Clawd speak normal now.');
    return;
  }

  if (text === '/rocky') {
    input.value = '';
    setMode('rocky');
    appendMessage('clawd', 'rocky mode. back to alien speak. good good.');
    return;
  }

  // ── Pet variant swaps ──
  const variants = {
    '/original': 'artboard-24cla.svg',
    '/hailmary': 'artboard-hailmary.svg',
    '/spiderman': 'artboard-spiderman.svg',
    '/zombie': 'artboard-zombie.svg',
    '/pirate': 'artboard-pirate.svg',
    '/wizard': 'artboard-wizard.svg',
  };
  if (variants[text]) {
    input.value = '';
    petImg.src = `assets/${variants[text]}`;
    petImg.classList.remove('bounce-in');
    void petImg.offsetWidth;
    petImg.classList.add('bounce-in');
    const name = text.slice(1);
    appendMessage('clawd', `Clawd look like ${name} now!`);
    return;
  }

  // Size commands
  if (text === '/big') {
    input.value = '';
    document.documentElement.style.zoom = '1.5';
    window.clawd.setWindowSize(240, 240);
    appendMessage('clawd', 'Clawd BIG now! massive. amaze.');
    return;
  }
  if (text === '/normal' || text === '/small') {
    input.value = '';
    document.documentElement.style.zoom = 'reset';
    window.clawd.setWindowSize(80, 80);
    appendMessage('clawd', 'Clawd back to normal size. tiny cute.');
    return;
  }

  if (text === '/wake') {
    input.value = '';
    appendMessage('clawd', 'wake word not available. use mic button, question?');
    return;
  }

  if (text.startsWith('/focus')) {
    input.value = '';
    if (focusMode) {
      cancelFocus();
      appendMessage('clawd', 'focus cancel. ok. rest now.');
    } else {
      const parts = text.split(' ');
      const min = parseInt(parts[1]) || 25;
      startFocus(min);
      appendMessage('clawd', `focus start. ${min} minute. Clawd guard. no distract.`);
    }
    return;
  }

  if (text === '/focusstats') {
    input.value = '';
    appendMessage('clawd', `focus session: ${focusSessions}. good effort. Clawd proud.`);
    return;
  }

  if (text === '/settings') {
    input.value = '';
    window.clawd.openSettings();
    return;
  }

  if (text === '/vault') {
    input.value = '';
    appendMessage('clawd', 'vault refresh. one moment...');
    refreshVault().then(() => {
      if (vaultContext) {
        appendMessage('clawd', `vault read. ${vaultContext.length} char load. Clawd know context now.`);
      } else {
        appendMessage('clawd', 'vault empty. no file find. path correct, question?');
      }
    });
    return;
  }

  if (text === '/brain') {
    input.value = '';
    window.clawd.readVaultBrain().then(content => {
      appendMessage('clawd', `brain today:\n${content}`);
    });
    return;
  }

  if (text === '/see' || text.startsWith('/see ')) {
    input.value = '';
    const question = text.length > 5 ? text.slice(5).trim() : 'what you see, question?';
    appendMessage('user', `[/see] ${question}`);
    setSvg('thinking');
    sendBtn.disabled = true;
    showTyping();
    try {
      const img = await window.clawd.captureScreen();
      if (!img) {
        appendMessage('error', 'Capture fail. Eyes broken.');
      } else {
        const reply = await window.clawd.visionChat(question, img);
        history.push({ role: 'user', content: `[looked at screen] ${question}` });
        history.push({ role: 'assistant', content: reply });
        window.clawd.saveHistory(history);
        setSvg(detectMood(reply));
        appendMessage('clawd', reply);
      }
    } catch (err) {
      setSvg('error');
      appendMessage('error', 'Vision fail.');
      console.error(err);
    } finally {
      hideTyping();
      sendBtn.disabled = false;
      input.focus();
    }
    return;
  }

  input.value = '';
  appendMessage('user', text);
  setSvg('thinking');
  sendBtn.disabled = true;
  showTyping();
  resetSleepTimer();

  try {
    // Intent detection first — fast call. If tool found, skip chat reply.
    const intentResult = await window.clawd.detectIntent(text);

    if (intentResult && intentResult.tool) {
      // Tool path: execute, show bubble result, no chat reply (command not conversation)
      const { tool, args, risk } = intentResult;
      let toolResult = null;

      try {
        if (risk === 'safe') {
          toolResult = await window.clawd.executeTool(tool, args);
        } else {
          const confirmed = await confirmTool(tool, args, risk === 'dangerous');
          if (confirmed) toolResult = await window.clawd.executeTool(tool, args);
        }
      } catch (toolErr) {
        toolResult = `tool fail: ${toolErr}`;
      }

      hideTyping();
      setSvg(toolResult && !toolResult.startsWith('tool fail') ? 'happy' : 'error');

      if (toolResult) {
        if (!memoryCats.actions) memoryCats.actions = [];
        memoryCats.actions.push(`${tool}(${JSON.stringify(args)}): ${toolResult}`);
        if (memoryCats.actions.length > 10) memoryCats.actions = memoryCats.actions.slice(-10);
        window.clawd.saveMemory(memoryCats);
        // Show in chat if open, bubble if closed
        if (chatOpen) appendMessage('clawd', toolResult);
        else showBubble(toolResult);
      }

      // Don't add to history — command not conversation
    } else {
      // Chat path: no tool, normal reply
      history.push({ role: 'user', content: text });
      const reply = await window.clawd.chat(history, currentContext, memoryCats, speechMode, vaultContext);

      history.push({ role: 'assistant', content: reply });
      window.clawd.saveHistory(history);

      messagesSinceLastSummarize += 2;
      if (messagesSinceLastSummarize >= SUMMARIZE_EVERY) {
        messagesSinceLastSummarize = 0;
        window.clawd.summarizeMemory(history.slice(-30), memoryCats).then(cats => {
          memoryCats = cats;
          window.clawd.saveMemory(cats);
          // Write observations to Clawd-Brain vault
          const recentUserMsgs = history.slice(-10)
            .filter(m => m.role === 'user')
            .map(m => m.content.slice(0, 80))
            .join(' | ');
          if (recentUserMsgs) {
            window.clawd.writeVaultBrain(`user: ${recentUserMsgs}`);
          }
          const newProjects = (cats.projects || []).slice(-2).join('; ');
          if (newProjects) window.clawd.writeVaultBrain(`projects: ${newProjects}`);
        });
      }

      setSvg(detectMood(reply));
      appendMessage('clawd', reply);
    }
  } catch (err) {
    setSvg('error');
    const msg = (err && err.message) || String(err) || 'unknown';
    appendMessage('error', `Screech! ${msg}`);
    console.error('Chat error:', err);
  } finally {
    hideTyping();
    sendBtn.disabled = false;
    input.focus();
  }
}

const typingIndicator = document.getElementById('typing-indicator');

function showTyping() { typingIndicator.classList.remove('hidden'); messagesEl.scrollTop = messagesEl.scrollHeight; }
function hideTyping() { typingIndicator.classList.add('hidden'); }

function nowStamp() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderCodeBlocks(container, text) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  parts.forEach(part => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
      const block = document.createElement('div');
      block.className = 'code-block';
      const pre = document.createElement('pre');
      pre.textContent = code;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.textContent = 'COPY';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = 'OK ✓';
          setTimeout(() => { copyBtn.textContent = 'COPY'; }, 1500);
        });
      };
      block.appendChild(pre);
      block.appendChild(copyBtn);
      container.appendChild(block);
    } else if (part) {
      const span = document.createElement('span');
      span.textContent = part;
      container.appendChild(span);
    }
  });
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.classList.add('msg', role);

  if (role === 'clawd') {
    const name = document.createElement('div');
    name.classList.add('name');
    name.textContent = 'CLAWD //';
    div.appendChild(name);

    const content = document.createElement('div');
    content.classList.add('msg-text');

    const hasCode = text.includes('```');
    if (hasCode) {
      content.classList.add('typing');
      div.appendChild(content);
      const timeEl = document.createElement('div');
      timeEl.classList.add('msg-time');
      timeEl.textContent = nowStamp();
      div.appendChild(timeEl);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      speak(text.replace(/```[\s\S]*?```/g, '').trim());
      renderCodeBlocks(content, text);
      content.classList.remove('typing');
    } else {
      content.classList.add('typing');
      div.appendChild(content);
      const timeEl = document.createElement('div');
      timeEl.classList.add('msg-time');
      timeEl.textContent = nowStamp();
      div.appendChild(timeEl);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      speak(text);
      let i = 0;
      function type() {
        if (i < text.length) {
          content.textContent += text[i++];
          messagesEl.scrollTop = messagesEl.scrollHeight;
          setTimeout(type, 20);
        } else {
          content.classList.remove('typing');
        }
      }
      type();
    }
  } else {
    const content = document.createElement('div');
    content.classList.add('msg-text');
    content.textContent = text;
    div.appendChild(content);
    if (role === 'user') {
      const timeEl = document.createElement('div');
      timeEl.classList.add('msg-time');
      timeEl.textContent = nowStamp();
      div.appendChild(timeEl);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// Start idle cycle + wandering on load
startIdleCycle();
resetSleepTimer();
setTimeout(startWalking, 8000);
setTimeout(startProactiveLoop, 60000);
