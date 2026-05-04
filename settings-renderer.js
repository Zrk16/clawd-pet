let currentSettings = {};

async function loadSettings() {
  currentSettings = await window.clawdSettings.getFullSettings();

  document.getElementById('tts-enabled').checked = !currentSettings.ttsMuted;
  document.getElementById('bubbles-enabled').checked = currentSettings.bubblesEnabled !== false;
  document.getElementById('walk-enabled').checked = currentSettings.walkEnabled !== false;
  document.getElementById('focus-duration').value = currentSettings.focusDuration || 25;

  const freq = document.getElementById('bubble-freq');
  freq.value = currentSettings.bubbleFrequency || 'normal';

  renderDistractionList(currentSettings.distractionApps || []);
}

function renderDistractionList(apps) {
  const list = document.getElementById('distraction-list');
  list.innerHTML = '';
  apps.forEach(app => {
    const tag = document.createElement('div');
    tag.className = 'distraction-tag';
    tag.innerHTML = `<span>${app}</span><button data-app="${app}" title="Remove">×</button>`;
    tag.querySelector('button').addEventListener('click', () => {
      const idx = currentSettings.distractionApps.indexOf(app);
      if (idx !== -1) currentSettings.distractionApps.splice(idx, 1);
      renderDistractionList(currentSettings.distractionApps);
    });
    list.appendChild(tag);
  });
}

document.getElementById('distraction-add-btn').addEventListener('click', () => {
  const input = document.getElementById('distraction-input');
  const val = input.value.trim();
  if (!val) return;
  if (!currentSettings.distractionApps) currentSettings.distractionApps = [];
  if (!currentSettings.distractionApps.includes(val)) {
    currentSettings.distractionApps.push(val);
    renderDistractionList(currentSettings.distractionApps);
  }
  input.value = '';
});

document.getElementById('distraction-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('distraction-add-btn').click();
});

document.getElementById('save-btn').addEventListener('click', () => {
  const s = {
    ttsMuted: !document.getElementById('tts-enabled').checked,
    bubblesEnabled: document.getElementById('bubbles-enabled').checked,
    walkEnabled: document.getElementById('walk-enabled').checked,
    focusDuration: parseInt(document.getElementById('focus-duration').value) || 25,
    bubbleFrequency: document.getElementById('bubble-freq').value,
    distractionApps: currentSettings.distractionApps || [],
  };
  window.clawdSettings.saveFullSettings(s);
  const status = document.getElementById('save-status');
  status.textContent = 'SAVED.';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

loadSettings();
