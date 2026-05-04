const pet = document.getElementById('pet');
document.getElementById('restart-btn').addEventListener('click', () => window.clawd.restart());
const petImg = document.getElementById('pet-img');
const chatPanel = document.getElementById('chat-panel');
const messagesEl = document.getElementById('messages');
const input = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const ttsBtn = document.getElementById('tts-btn');
const micBtn = document.getElementById('mic-btn');

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

// ── Ambient Intelligence: AFK ──
let lastActiveTime = Date.now();
let afkState = 'active'; // active, sitting, sleeping
let afkSitTimer = null;
let afkSleepTimer = null;

// ── Ambient Intelligence: Clipboard ──
let lastClipboardHash = '';

// ── Ambient Intelligence: Meeting ──
let meetingMode = false;

// ── Ambient Intelligence: Caffeine (late night) ──
let caffeineNudgeDone = false;

// ── Ambient Intelligence: Thought bubble ──
let thoughtBubbleTimer = null;

// ── Visual: Time-reactive appearance ──
let timeOfDayClass = '';

// ── Visual: Particle trail ──
let particleContainer = null;
let isWalking = false;

// ── Visual: Weather-reactive ──
let weatherClass = '';

// ── Ambient Intelligence: Browser title reactions ──
const TITLE_REACTIONS = {
  'stackoverflow': "Stack Overflow again. What break this time?",
  'github': "GitHub. Code happen. good good.",
  'youtube': "YouTube. Watch or work, question?",
  'reddit': "Reddit. procrastination strong with this one.",
  'twitter': "Twitter. doom scroll begin, question?",
  'netflix': "Netflix. rest time, question?",
  'discord': "Discord. social time. Clawd wait.",
  'spotify': "Music play. Clawd like beats.",
  'notion': "Notion. organize time. Clawd approve.",
  'slack': "Slack. work chat. respond fast, question?",
};


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
      setTimeout(() => {
        const timeGreeting = getTimeAwareGreeting();
        const msg = timeGreeting || 'new day. Clawd wake. human here, question? good good.';
        showBubble(msg);
        applyTimeOfDayClass();
      }, 5000);
    }
    applyTimeOfDayClass(); // Check on every open, not just first
    checkCaffeine(); // Check caffeine on startup
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
  if (settings.uiPreset) applyUiPreset(settings.uiPreset);
}

// ── UI Preset system ──
let currentPresetLink = null;

function applyUiPreset(preset) {
  const app = document.getElementById('app');
  if (!app) return;

  app.classList.remove('preset-og', 'preset-crt', 'preset-gameboy', 'preset-vhs', 'preset-dos', 'preset-synthwave', 'preset-midnight', 'preset-grimoire', 'preset-ink', 'preset-paper', 'preset-nordic', 'preset-neon-punk', 'preset-comic-book', 'preset-memphis', 'preset-silkscreen', 'preset-marshmallow', 'preset-liquid-glass', 'preset-minimal', 'preset-neon', 'preset-retro', 'preset-botanical', 'preset-ocean', 'preset-sunset', 'preset-monochrome', 'preset-pastel', 'preset-gradient', 'preset-material', 'preset-flat', 'preset-glass-dark');
  app.classList.add('preset-' + preset);

  // Load preset CSS if not og
  if (preset !== 'og') {
    if (!currentPresetLink) {
      currentPresetLink = document.createElement('link');
      currentPresetLink.rel = 'stylesheet';
      document.head.appendChild(currentPresetLink);
    }
    currentPresetLink.href = preset + '.css';
  } else if (currentPresetLink) {
    currentPresetLink.href = '';
  }
}

// Listen for preset from main process
window.clawd.onUiPreset((preset) => applyUiPreset(preset));

// Listen for settings updates (preset changed in settings panel)
window.clawd.onSettingsUpdated((settings) => {
  if (settings.uiPreset) applyUiPreset(settings.uiPreset);
});

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

// ── Ambient: Time-aware greeting ──
function getTimeAwareGreeting() {
  const hour = new Date().getHours();
  const day = new Date().getDay();
  if (day === 0 && hour >= 20) return "Sunday night. big week ahead. Clawd ready.";
  if (day === 1 && hour >= 6 && hour <= 9) return "Monday. new week. Clawd believe in human.";
  if (day === 5 && hour >= 14) return "FRIDAY. WEEKEND COME. goodods.";
  if (hour >= 23 || hour <= 3) return "late night. Clawd still here.";
  return null;
}

// ── Ambient: Clipboard watcher ──
let clipboardWatcherInterval = null;
function startClipboardWatcher() {
  if (clipboardWatcherInterval) return;
  clipboardWatcherInterval = setInterval(async () => {
    if (chatOpen || focusMode || meetingMode) return;
    try {
      const { text, hash, changed } = await window.clawd.getClipboardHash();
      if (!changed || !text || text.length < 5 || text.length > 500) return;
      lastClipboardHash = hash;
      const preview = text.slice(0, 60).replace(/\n/g, ' ');
      showBubble(`Clawd see: "${preview}..." explain, question?`);
      setTimeout(() => speak(`human copy: ${preview}. want explain, question?`, 'curious'), 500);
    } catch {}
  }, 30000);
}
startClipboardWatcher();

// ── Ambient: AFK state management (5min sit, 15min sleep) ──
function updateAfkState() {
  const diff = Date.now() - lastActiveTime;
  const mins = Math.floor(diff / 60000);

  if (afkState === 'sleeping' && diff < 5 * 60000) {
    // Woke up
    afkState = 'active';
    clearTimeout(afkSleepTimer);
    const sleptMins = Math.floor((Date.now() - (afkSleepTimer?._start || Date.now())) / 60000);
    setSvg('greeting');
    showBubble(`back. Clawd wait ${sleptMins} minute. is fine.`);
    speak(`back. Clawd wait ${sleptMins} minute. is fine.`, 'greeting');
  } else if (afkState === 'active' && mins >= 5 && mins < 15) {
    // Start sitting
    afkState = 'sitting';
    setSvg('idle');
    clearTimeout(afkSitTimer);
    afkSitTimer = setTimeout(() => {
      if (afkState === 'sitting') {
        afkState = 'sleeping';
        setSvg('sleeping');
        petImg.src = petImg.src.replace('artboard-24', 'sleeping');
      }
    }, 10 * 60000); // 10 more min = 15 total
  } else if (afkState === 'sitting' && mins >= 15) {
    afkState = 'sleeping';
    setSvg('sleeping');
  }
}
function resetAfkTimer() {
  lastActiveTime = Date.now();
  if (afkState !== 'active') {
    afkState = 'active';
    if (petImg.src.includes('sleeping') || petImg.src.includes('idle')) {
      setSvg('greeting');
    }
  }
}

// ── Ambient: Meeting detection (Zoom/Teams/Meet) ──
function checkMeeting(title) {
  const meetingApps = ['zoom', 'teams', 'meet', 'webex'];
  const isMeeting = meetingApps.some(m => title.toLowerCase().includes(m));
  if (isMeeting && !meetingMode) {
    meetingMode = true;
    const wasMuted = ttsMuted;
    ttsMuted = true;
    updateTtsBtn();
    showBubble('meeting detect. Clawd be quiet. talk soon.');
    setTimeout(() => { meetingMode = false; ttsMuted = wasMuted; updateTtsBtn(); }, 60000);
  }
}

// ── Ambient: Caffeine timer (past midnight) ──
function checkCaffeine() {
  const hour = new Date().getHours();
  if (hour >= 1 && hour <= 4 && !caffeineNudgeDone && !chatOpen && !focusMode) {
    caffeineNudgeDone = true;
    setTimeout(() => {
      showBubble('2am. human still awake. caffeine high. sleep soon, question?');
    }, 30000);
  }
  if (hour >= 6) caffeineNudgeDone = false; // Reset after 6am
}

// ── Ambient: Browser title reactions ──
function checkTitleReaction(title) {
  const lower = title.toLowerCase();
  for (const [keyword, response] of Object.entries(TITLE_REACTIONS)) {
    if (lower.includes(keyword) && Math.random() < 0.15) {
      showBubble(response);
      return;
    }
  }
}

// ── Visual: Time-reactive appearance (morning/night) ──
function applyTimeOfDayClass() {
  const hour = new Date().getHours();
  let newClass = '';
  if (hour >= 6 && hour <= 9) newClass = 'morning-mode';
  else if (hour >= 23 || hour <= 3) newClass = 'night-mode';

  if (newClass !== timeOfDayClass) {
    timeOfDayClass = newClass;
    const container = document.getElementById('pet-container');
    container.classList.remove('morning-mode', 'night-mode');
    if (newClass) container.classList.add(newClass);
  }
}

// ── Visual: Thought bubble (idle "...") ──
function showThoughtBubble() {
  if (chatOpen || focusMode || bubbleVisible || meetingMode) return;
  showBubble('...');
  setTimeout(hideBubble, 4000);
}
function startThoughtBubbleTimer() {
  if (thoughtBubbleTimer) clearInterval(thoughtBubbleTimer);
  thoughtBubbleTimer = setInterval(() => {
    if (Math.random() < 0.3) showThoughtBubble();
  }, 300000); // Every 5 min, 30% chance
}
startThoughtBubbleTimer();

// ── Visual: Particle trail when walking ──
function createParticle(x, y) {
  if (!particleContainer) {
    particleContainer = document.createElement('div');
    particleContainer.id = 'particle-container';
    particleContainer.style.cssText = 'position:absolute;pointer-events:none;z-index:-1;';
    document.getElementById('pet-container').appendChild(particleContainer);
  }
  const p = document.createElement('div');
  p.style.cssText = `
    position:absolute;width:4px;height:4px;background:#FFB07A;border-radius:50%;
    opacity:0.6;left:${x}px;top:${y}px;transition:all 1.5s ease-out;
  `;
  particleContainer.appendChild(p);
  requestAnimationFrame(() => {
    p.style.transform = `translate(${Math.random()*40-20}px, ${Math.random()*40-20}px)`;
    p.style.opacity = '0';
  });
  setTimeout(() => p.remove(), 1500);
}

// ── Visual: Weather-reactive appearance ──
function applyWeatherClass(weatherOutput) {
  if (!weatherOutput || weatherOutput.includes('fail') || weatherOutput.includes('timeout')) return;
  const lower = weatherOutput.toLowerCase();
  let newClass = '';
  if (lower.includes('rain') || lower.includes('drizzle') || lower.includes('shower')) newClass = 'rainy';
  else if (lower.includes('sunny') || lower.includes('clear')) newClass = 'sunny';

  if (newClass !== weatherClass) {
    weatherClass = newClass;
    const container = document.getElementById('pet-container');
    container.classList.remove('rainy', 'sunny');
    if (newClass) container.classList.add(newClass);
  }
}

// ── Battery warning ──
window.clawd.onCheckBattery(async () => {
  try {
    const { onBattery, low } = await window.clawd.getBattery();
    if (onBattery && low && !bubbleVisible) {
      showBubble('low battery. save work soon. Clawd worry.');
    }
  } catch {}
});

// ── Periodic particle spawner (simple: occasional ambient particles) ──
setInterval(() => {
  if (afkState !== 'active' || focusMode || chatOpen || meetingMode) return;
  if (Math.random() < 0.08) {
    const rect = document.getElementById('pet').getBoundingClientRect();
    createParticle(rect.width / 2 + Math.random() * 20 - 10, rect.height / 2 + Math.random() * 20 - 10);
  }
}, 2000);

// ── AFK state polling (backup for when context doesn't change) ──
setInterval(() => {
  updateAfkState();
  checkCaffeine();
  applyTimeOfDayClass();
}, 60000); // Check every minute

window.clawd.onContextChange((ctx) => {
  currentContext = ctx;
  resetAfkTimer(); // Reset AFK timer on any context change
  applyTimeOfDayClass(); // Update time-reactive appearance

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

  // Meeting detection
  checkMeeting(ctx.title || '');

  // Browser title reactions
  if (!chatOpen && !bubbleVisible) checkTitleReaction(ctx.title || '');

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
        // Weather reactive: apply visual class based on weather output
        if (tool === 'get_weather') applyWeatherClass(toolResult);
        
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
