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
let memoryFacts = [];
let chatOpen = false;
let speechMode = 'rocky'; // 'rocky' | 'smart'
let idleTimer = null;
let idleCycleTimer = null;
let idleIndex = 0;
let currentContext = null;
let messagesSinceLastSummarize = 0;
const SUMMARIZE_EVERY = 10;

async function initMemory() {
  history = await window.clawd.loadHistory();
  memoryFacts = await window.clawd.loadMemory();
}

initMemory();

// ── TTS (Web Speech API) ──
let ttsMuted = false;
let ttsVoice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  // Prefer Microsoft male English voices for alien-Rocky vibe
  const prefer = voices.find(v => /david|guy|mark/i.test(v.name) && /en/i.test(v.lang))
              || voices.find(v => v.lang.startsWith('en') && /male/i.test(v.name))
              || voices.find(v => v.lang.startsWith('en'));
  return prefer || voices[0];
}

speechSynthesis.addEventListener('voiceschanged', () => {
  ttsVoice = pickVoice();
});
ttsVoice = pickVoice();

function speak(text) {
  if (ttsMuted || !text) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  if (ttsVoice) utter.voice = ttsVoice;
  utter.pitch = 0.6;   // low — alien
  utter.rate = 0.95;   // slightly slow
  utter.volume = 1;
  speechSynthesis.speak(utter);
}

async function initTtsState() {
  const settings = await window.clawd.loadSettings();
  ttsMuted = !!settings.ttsMuted;
  updateTtsBtn();
  if (settings.wakeWordEnabled) {
    setTimeout(() => setWakeEnabled(true), 1500);
  }
}

function saveAllSettings() {
  window.clawd.saveSettings({ ttsMuted, wakeWordEnabled: wakeEnabled });
}

function updateTtsBtn() {
  ttsBtn.classList.toggle('muted', ttsMuted);
  ttsBtn.textContent = ttsMuted ? '♪̸' : '♪';
  ttsBtn.title = ttsMuted ? 'Voice off — click to enable' : 'Voice on — click to mute';
}

ttsBtn.addEventListener('click', () => {
  ttsMuted = !ttsMuted;
  if (ttsMuted) speechSynthesis.cancel();
  updateTtsBtn();
  saveAllSettings();
});

initTtsState();

// ── Mode toggle (/rocky | /smart) ──
const modeBtn = document.getElementById('mode-btn');

function setMode(m) {
  speechMode = m;
  modeBtn.textContent = `/${m}`;
  modeBtn.classList.toggle('smart', m === 'smart');
}

modeBtn.addEventListener('click', () => setMode(speechMode === 'rocky' ? 'smart' : 'rocky'));

// ── Copy last response ──
document.getElementById('copy-btn').addEventListener('click', () => {
  const msgs = document.querySelectorAll('.msg.clawd');
  if (!msgs.length) return;
  const last = msgs[msgs.length - 1].innerText;
  navigator.clipboard.writeText(last).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⎘'; }, 1200);
  });
});

// ── STT (Web Speech Recognition) ──
// Two modes: command (single utterance → fill input + send) and wake (continuous → trigger on "clawd")
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let srMode = 'idle'; // 'idle' | 'command' | 'wake'
let wakeEnabled = false;

function buildRecognition() {
  if (!SR) return null;
  const r = new SR();
  r.lang = 'en-US';
  r.maxAlternatives = 1;
  return r;
}

function startCommand() {
  if (!SR) return;
  if (srMode === 'wake') stopRecognition();
  recognition = buildRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  srMode = 'command';
  micBtn.classList.add('listening');
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript.trim();
    if (transcript) {
      input.value = transcript;
      sendMessage();
    }
  };
  recognition.onerror = () => endCommand();
  recognition.onend = () => endCommand();
  speechSynthesis.cancel();
  try { recognition.start(); } catch { endCommand(); }
}

function endCommand() {
  micBtn.classList.remove('listening');
  srMode = 'idle';
  recognition = null;
  if (wakeEnabled) setTimeout(startWake, 400);
}

function startWake() {
  if (!SR || !wakeEnabled || srMode !== 'idle' || chatOpen) return;
  recognition = buildRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  srMode = 'wake';
  recognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.toLowerCase();
      if (/\b(clawd|claude|cloud)\b/.test(t)) {
        stopRecognition();
        if (!chatOpen) pet.click(); // open chat
        setTimeout(startCommand, 600);
        return;
      }
    }
  };
  recognition.onerror = (ev) => {
    if (ev.error === 'no-speech' || ev.error === 'audio-capture') return; // benign
    console.warn('wake SR err:', ev.error);
  };
  recognition.onend = () => {
    srMode = 'idle';
    recognition = null;
    if (wakeEnabled && !chatOpen) setTimeout(startWake, 800);
  };
  try { recognition.start(); } catch { srMode = 'idle'; recognition = null; }
}

function stopRecognition() {
  if (recognition) {
    try { recognition.abort(); } catch {}
    recognition = null;
  }
  srMode = 'idle';
  micBtn.classList.remove('listening');
}

if (!SR) micBtn.style.display = 'none';

micBtn.addEventListener('click', () => {
  if (srMode === 'command') stopRecognition();
  else startCommand();
});

function setWakeEnabled(on) {
  wakeEnabled = on;
  if (on) startWake();
  else stopRecognition();
}

// ── App name → mood map (for screen awareness reactions) ──
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

window.clawd.onContextChange((ctx) => {
  currentContext = ctx;
  // Only react visually if chat closed and not sleeping
  if (!chatOpen && petImg.src && !petImg.src.includes('sleeping')) {
    const mood = APP_MOODS[ctx.app];
    if (mood) {
      setSvg(mood);
      resetSleepTimer();
    }
  }
  // 25% chance to remark on app switch, throttled to 1 per 90s
  const now = Date.now();
  if (!chatOpen && !bubbleVisible && now - lastContextRemarkAt > 90000 && Math.random() < 0.25) {
    lastContextRemarkAt = now;
    fireProactive();
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

// ── Keyword → mood override (scans Clawd's reply) ──
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
  const src = pickSvg(mood);
  // Skip bounce if SVG didn't change — avoids visual jump on chat toggle
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
const PROACTIVE_MIN_MS = 3 * 60 * 1000;   // 3min minimum gap
const PROACTIVE_MAX_MS = 8 * 60 * 1000;   // 8min max gap

function showBubble(text) {
  if (!text || chatOpen) return;
  bubble.textContent = text;
  bubbleVisible = true;
  // Stop walking while bubble shows
  stopWalking();
  // Resize window to accommodate bubble
  window.clawd.toggleBubble(true);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => bubble.classList.remove('hidden'));
  });
  // Speak it too if TTS on
  speak(text);
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(hideBubble, 8000);
}

function hideBubble() {
  if (!bubbleVisible) return;
  bubbleVisible = false;
  bubble.classList.add('hidden');
  clearTimeout(bubbleHideTimer);
  setTimeout(() => {
    if (!bubbleVisible && !chatOpen) {
      window.clawd.toggleBubble(false);
      startWalking();
    }
  }, 320);
}

bubble.addEventListener('click', () => {
  hideBubble();
  pet.click(); // open chat
});

async function fireProactive() {
  if (chatOpen || bubbleVisible || !currentContext) return;
  try {
    const remark = await window.clawd.proactive(currentContext, memoryFacts);
    if (remark) showBubble(remark);
  } catch { /* swallow */ }
}

function startProactiveLoop() {
  clearTimeout(proactiveTimer);
  const gap = PROACTIVE_MIN_MS + Math.random() * (PROACTIVE_MAX_MS - PROACTIVE_MIN_MS);
  proactiveTimer = setTimeout(async () => {
    await fireProactive();
    startProactiveLoop();
  }, gap);
}

// ── Idle walk ──
let walkTimer = null;
let homeX = null;
let homeY = null;
const WALK_RADIUS = 150; // stay within 150px of home

async function startWalking() {
  if (walkTimer) return;

  const tick = async () => {
    if (chatOpen || bubbleVisible) return stopWalking();
    const pos = await window.clawd.getWindowPos();
    const { x, y, screenMinX, screenMaxX } = pos;

    // Set home on first walk — lock both X and Y so walk stays side-to-side at fixed height
    if (homeX === null) { homeX = x; homeY = y; }

    // Walk radius around home position, clamped to screen
    const homeLeft = Math.max(screenMinX, homeX - WALK_RADIUS);
    const homeRight = Math.min(screenMaxX, homeX + WALK_RADIUS);
    const targetX = homeLeft + Math.random() * (homeRight - homeLeft);

    const duration = 2500 + Math.random() * 2500;
    window.clawd.walkTo(targetX, homeY, duration); // lock Y to home — no vertical drift
    walkTimer = setTimeout(tick, duration + 1500 + Math.random() * 4000);
  };
  walkTimer = setTimeout(tick, 5000);
}

function stopWalking() {
  clearTimeout(walkTimer);
  walkTimer = null;
  window.clawd.cancelWalk(); // kill any in-flight interpolation in main process
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
  resetWalkHome(); // user moved pet → new home
  // Suppress next click event (fires after mouseup)
  setTimeout(() => { justDragged = false; }, 50);
});

// ── Toggle chat ──
pet.addEventListener('click', (e) => {
  if (e.ctrlKey || justDragged) return;
  chatOpen = !chatOpen;
  resetSleepTimer();

  if (chatOpen) {
    stopWalking();
    hideBubble();
    if (srMode === 'wake') stopRecognition();
    // Resize window first, reveal chat after window is ready
    window.clawd.toggleChat(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chatPanel.classList.remove('hidden');
        input.focus();
      });
    });
    if (history.length === 0) {
      setSvg('greeting');
    } else {
      setSvg('idle');
    }
    stopIdleCycle();
  } else {
    // Hide chat first, shrink window after fade
    chatPanel.classList.add('hidden');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clawd.toggleChat(false);
      });
    });
    startIdleCycle();
    startWalking();
    if (wakeEnabled) setTimeout(startWake, 800);
  }
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

  // Debug command — show raw window data
  if (text === '/ctx') {
    input.value = '';
    const data = await window.clawd.debugContext();
    appendMessage('clawd', `RAW: ${JSON.stringify(data, null, 2)}`);
    return;
  }

  // Exit command
  if (text === '/exit' || text === '/quit') {
    input.value = '';
    appendMessage('clawd', 'Clawd sleep. bye bye.');
    setTimeout(() => window.clawd.quit(), 400);
    return;
  }

  // Restart command
  if (text === '/restart') {
    input.value = '';
    appendMessage('clawd', 'Clawd reboot. brain reset.');
    setTimeout(() => window.clawd.restart(), 400);
    return;
  }

  // Mode toggle
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

  // Wake word toggle
  if (text === '/wake') {
    input.value = '';
    setWakeEnabled(!wakeEnabled);
    saveAllSettings();
    appendMessage('clawd', wakeEnabled
      ? 'Clawd ear open. say "Clawd" to wake.'
      : 'Clawd ear close. quiet now.');
    return;
  }

  // Vision command — /see [optional question]
  if (text === '/see' || text.startsWith('/see ')) {
    input.value = '';
    const question = text.length > 5 ? text.slice(5).trim() : 'what you see, question?';
    appendMessage('user', `[/see] ${question}`);
    setSvg('thinking');
    sendBtn.disabled = true;
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
      sendBtn.disabled = false;
      input.focus();
    }
    return;
  }

  input.value = '';
  appendMessage('user', text);
  history.push({ role: 'user', content: text });

  setSvg('thinking');
  sendBtn.disabled = true;
  resetSleepTimer();

  try {
    const reply = await window.clawd.chat(history, currentContext, memoryFacts, speechMode);
    history.push({ role: 'assistant', content: reply });
    window.clawd.saveHistory(history);

    messagesSinceLastSummarize += 2; // user + assistant
    if (messagesSinceLastSummarize >= SUMMARIZE_EVERY) {
      messagesSinceLastSummarize = 0;
      // summarize in background — don't await, don't block chat
      window.clawd.summarizeMemory(history.slice(-30), memoryFacts).then(facts => {
        memoryFacts = facts;
        window.clawd.saveMemory(facts);
      });
    }

    const mood = detectMood(reply);
    setSvg(mood);
    appendMessage('clawd', reply);
  } catch (err) {
    setSvg('error');
    const msg = (err && err.message) || String(err) || 'unknown';
    appendMessage('error', `Screech! ${msg}`);
    console.error('Chat error:', err);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
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
    content.classList.add('msg-text', 'typing');
    div.appendChild(content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Speak the message in parallel with typewriter
    speak(text);

    let i = 0;
    function type() {
      if (i < text.length) {
        content.textContent += text[i++];
        messagesEl.scrollTop = messagesEl.scrollHeight;
        setTimeout(type, 22);
      } else {
        content.classList.remove('typing');
      }
    }
    type();
  } else {
    const content = document.createElement('div');
    content.classList.add('msg-text');
    content.textContent = text;
    div.appendChild(content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// Start idle cycle + wandering on load
startIdleCycle();
resetSleepTimer();
setTimeout(startWalking, 8000);
setTimeout(startProactiveLoop, 60000); // first proactive after 1min
