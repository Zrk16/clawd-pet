const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawd', {
  chat: (messages, context, memory, mode, vaultContext) => ipcRenderer.invoke('chat', { messages, context, memory, mode, vaultContext }),
  toggleChat: (open) => ipcRenderer.send('toggle-chat', open),
  toggleBubble: (show) => ipcRenderer.send('toggle-bubble', show),
  restart: () => ipcRenderer.send('restart'),
  quit: () => ipcRenderer.send('quit'),
  onContextChange: (cb) => ipcRenderer.on('context-change', (_, ctx) => cb(ctx)),
  debugContext: () => ipcRenderer.invoke('debug-context'),
  loadHistory: () => ipcRenderer.invoke('load-history'),
  saveHistory: (history) => ipcRenderer.send('save-history', history),
  loadMemory: () => ipcRenderer.invoke('load-memory'),
  saveMemory: (data) => ipcRenderer.send('save-memory', data),
  summarizeMemory: (messages, existingMemory) => ipcRenderer.invoke('summarize-memory', { messages, existingMemory }),
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  getWindowPos: () => ipcRenderer.invoke('get-window-pos'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (s) => ipcRenderer.send('save-settings', s),
  walkTo: (x, y, duration) => ipcRenderer.send('walk-to', { x, y, duration }),
  cancelWalk: () => ipcRenderer.send('cancel-walk'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  visionChat: (question, imageDataUrl) => ipcRenderer.invoke('vision-chat', { question, imageDataUrl }),
  proactive: (context, memory) => ipcRenderer.invoke('proactive', { context, memory }),
  synthesizeSpeech: (text, mood) => ipcRenderer.invoke('synthesize-speech', { text, mood }),
  sttTranscribe: (ab) => ipcRenderer.invoke('stt-transcribe', Buffer.from(ab)),
  onSttStatus: (cb) => ipcRenderer.on('stt-status', (_, s) => cb(s)),
  // Mark 10: tool system
  detectIntent: (message) => ipcRenderer.invoke('detect-intent', message),
  executeTool: (tool, args) => ipcRenderer.invoke('execute-tool', { tool, args }),
  // Mark 10: hotkey
  onHotkeyAction: (cb) => ipcRenderer.on('hotkey-action', (_, action) => cb(action)),
  sendChatOpen: (open) => ipcRenderer.send('chat-open', open),
  // Mark 10: first open of day
  checkFirstOpen: () => ipcRenderer.invoke('check-first-open'),
  // Mark 10: same-app notify
  onSameAppNotify: (cb) => ipcRenderer.on('same-app-notify', (_, ctx) => cb(ctx)),
  // Mark 11: focus poll, context menu, settings, reminders
  setFocusPoll: (fast) => ipcRenderer.send('set-focus-poll', fast),
  showContextMenu: (state) => ipcRenderer.send('show-context-menu', state),
  onCtxMenuAction: (cb) => ipcRenderer.on('ctx-menu-action', (_, action) => cb(action)),
  openSettings: () => ipcRenderer.send('open-settings'),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (_, s) => cb(s)),
  onReminderFire: (cb) => ipcRenderer.on('reminder-fire', (_, text) => cb(text)),
  // Mark 11: Obsidian vault
  readVault: () => ipcRenderer.invoke('read-vault'),
  readVaultBrain: () => ipcRenderer.invoke('read-vault-brain'),
  writeVaultBrain: (text) => ipcRenderer.send('write-vault-brain', text),
  // UI presets
  onUiPreset: (cb) => ipcRenderer.on('ui-preset', (_, preset) => cb(preset)),
  // Mark 12: Ambient Intelligence
  getBattery: () => ipcRenderer.invoke('get-battery'),
  getClipboardHash: () => ipcRenderer.invoke('get-clipboard-hash'),
  onCheckBattery: (cb) => ipcRenderer.on('check-battery', () => cb()),
  setWindowSize: (w, h) => ipcRenderer.send('set-window-size', { width: w, height: h }),
});
