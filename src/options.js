import { normalizeSettings } from './policy.js';

const form = document.getElementById('form');
const fields = form.elements; // use .elements: form.action would be the form's own action URL
const savedNote = document.getElementById('saved');
let savedTimer;

const UNITS = [1440, 60, 1];
const pickUnit = (minutes) => UNITS.find((unit) => minutes % unit === 0) ?? 1;

async function load() {
  return normalizeSettings(await chrome.storage.sync.get(null));
}

function fill(settings) {
  const unit = pickUnit(settings.idleMinutes);
  fields.enabled.checked = settings.enabled;
  fields.idleUnit.value = String(unit);
  fields.idleAmount.value = String(settings.idleMinutes / unit);
  fields.action.value = settings.action;
  fields.minTabsPerWindow.value = String(settings.minTabsPerWindow);
  fields.protectPinned.checked = settings.protectPinned;
  fields.protectAudible.checked = settings.protectAudible;
  fields.protectGrouped.checked = settings.protectGrouped;
  fields.pauseWhenAway.checked = settings.pauseWhenAway;
  fields.whitelist.value = settings.whitelist.join('\n');
  fields.historyLimit.value = String(settings.historyLimit);
}

function read() {
  return normalizeSettings({
    enabled: fields.enabled.checked,
    idleMinutes: Number(fields.idleAmount.value) * Number(fields.idleUnit.value),
    action: fields.action.value,
    minTabsPerWindow: fields.minTabsPerWindow.value,
    protectPinned: fields.protectPinned.checked,
    protectAudible: fields.protectAudible.checked,
    protectGrouped: fields.protectGrouped.checked,
    pauseWhenAway: fields.pauseWhenAway.checked,
    whitelist: fields.whitelist.value,
    historyLimit: fields.historyLimit.value,
  });
}

function flashSaved(text = 'Saved') {
  savedNote.textContent = text;
  savedNote.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedNote.classList.remove('show'), 1600);
}

// Save on "change" only (blur / Enter / click), never per keystroke: typing "120" must not briefly
// save a 1-minute threshold and sweep everything in between.
form.addEventListener('change', async () => {
  const settings = read();
  await chrome.storage.sync.set(settings);
  fill(settings); // show the cleaned-up values (clamped numbers, normalized sites)
  flashSaved();
});

form.addEventListener('submit', (event) => event.preventDefault());

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.sync.clear();
  fill(await load());
  flashSaved('Defaults restored');
});

// Keep in sync with changes made elsewhere (e.g. the popup's Auto switch), unless you're mid-edit.
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== 'sync') return;
  const editing = document.activeElement?.matches('input[type="number"], textarea');
  if (!editing) fill(await load());
});

// Keyboard shortcut for "keep this tab open". chrome:// pages can't be linked to directly.
document.getElementById('change-shortcut').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

async function showShortcut() {
  const command = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-keep');
  const keys = command?.shortcut || '';
  document.getElementById('shortcut').textContent = keys;
  document.getElementById('shortcut-hint').hidden = !keys;
  document.getElementById('change-shortcut').textContent = keys ? 'Change shortcut' : 'Set a keyboard shortcut';
}
// Pick up changes made on chrome://extensions/shortcuts when you come back to this tab.
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && showShortcut());

fill(await load());
showShortcut();
