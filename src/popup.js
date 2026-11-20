import { MINUTE, formatDuration, hostOf, plural } from './format.js';

const SOON_MS = 15 * MINUTE;
const REFRESH_MS = 20_000;

// Static, trusted SVG markup from Lucide (ISC; x and lock via Feather, MIT). See Credits in README.md.
// Never mix page data into these strings.
const ICONS = {
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

const $ = (id) => document.getElementById(id);
let data = null;
let view = 'open';
let shortcut = ''; // e.g. "⌥⇧K"; empty if the user removed it
let toastTimer;

// ---------------------------------------------------------------------------
// Helpers

function icon(name) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  span.style.display = 'contents';
  return span;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function faviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl || 'about:blank');
  url.searchParams.set('size', '32');
  return url.toString();
}

const pref = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable; preference just won't stick */
    }
  },
};

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'No response from Tab Sweeper');
  return response.result;
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2200);
}

async function act(type, payload, message) {
  try {
    const result = await send(type, payload);
    if (message) toast(typeof message === 'function' ? message(result) : message);
    await refresh();
    return result;
  } catch (error) {
    toast(error.message);
  }
}

// ---------------------------------------------------------------------------
// Rendering

function statusFor(tab, settings) {
  const idle = formatDuration(tab.idleMs);
  const verb = settings.action === 'discard' ? 'sleeps' : 'closes';
  const labels = {
    active: 'Active now',
    kept: 'Kept open',
    pinned: 'Pinned',
    audible: 'Playing audio',
    grouped: 'In a tab group',
    whitelist: 'Allow-listed site',
    discarded: 'Asleep',
    untracked: 'Just opened',
  };
  if (tab.protectedBy) {
    const tone = tab.protectedBy === 'active' || tab.protectedBy === 'kept' ? 'ok' : 'muted';
    const suffix = tab.protectedBy === 'active' || tab.protectedBy === 'untracked' ? '' : ` · idle ${idle}`;
    return { text: labels[tab.protectedBy] + suffix, tone };
  }
  if (!settings.enabled) return { text: `Idle ${idle}`, tone: 'muted' };
  if (tab.held) return { text: `Idle ${idle} · held by minimum-tabs rule`, tone: 'muted' };
  if (tab.eligible) return { text: `Idle ${idle} · ${verb} within a minute`, tone: 'due' };
  return {
    text: `Idle ${idle} · ${verb} in ${formatDuration(tab.remainingMs)}`,
    tone: tab.remainingMs <= SOON_MS ? 'warn' : 'muted',
  };
}

function sortTabs(tabs, order) {
  const sorted = [...tabs];
  if (order === 'window') return sorted.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const dir = order === 'recent' ? 1 : -1;
  // Active tabs always sink to the bottom of "least recent" (and top of "most recent").
  return sorted.sort((a, b) => (a.active - b.active) * -dir || (a.idleMs - b.idleMs) * dir);
}

function matches(query, ...fields) {
  if (!query) return true;
  return fields.some((field) => field?.toLowerCase().includes(query));
}

function openRow(tab) {
  const status = statusFor(tab, data.settings);
  const keepLabel = tab.kept ? 'Stop keeping this tab open' : 'Keep this tab open';
  const keepHint = tab.active && shortcut ? `${keepLabel} (${shortcut})` : keepLabel;
  return el(
    'li',
    { class: `row tone-${status.tone}${tab.active ? ' is-active' : ''}` },
    el('img', { class: 'favicon', src: faviconUrl(tab.url), alt: '' }),
    el(
      'button',
      { class: 'row-main', title: tab.url, onclick: () => focusTab(tab) },
      el('span', { class: 'title' }, tab.title || tab.url || 'Untitled'),
      el('span', { class: 'meta' }, el('span', { class: 'status' }, status.text), el('span', { class: 'host' }, hostOf(tab.url))),
    ),
    el(
      'button',
      {
        class: `icon-btn keep${tab.kept ? ' on' : ''}`,
        title: keepHint,
        'aria-label': keepLabel,
        'aria-keyshortcuts': tab.active && shortcut ? shortcut : null,
        'aria-pressed': String(tab.kept),
        onclick: () => act('toggleKeep', { tabId: tab.id }, (kept) => (kept ? 'Tab will be kept open' : 'Tab is back on the clock')),
      },
      icon('lock'),
    ),
    el(
      'button',
      { class: 'icon-btn danger', title: 'Close tab', 'aria-label': 'Close tab', onclick: () => act('closeTab', { tabId: tab.id }) },
      icon('x'),
    ),
  );
}

const REASONS = { idle: 'idle', duplicate: 'duplicate', manual: 'closed by you' };

function closedRow(entry) {
  return el(
    'li',
    { class: 'row' },
    el('img', { class: 'favicon', src: faviconUrl(entry.url), alt: '' }),
    el(
      'button',
      { class: 'row-main', title: `Reopen ${entry.url}`, onclick: () => act('restore', { id: entry.id, focus: true }).then(() => window.close()) },
      el('span', { class: 'title' }, entry.title || entry.url),
      el(
        'span',
        { class: 'meta' },
        el('span', { class: 'status' }, `${formatDuration(data.now - entry.closedAt)} ago · ${REASONS[entry.reason] ?? entry.reason}`),
        el('span', { class: 'host' }, hostOf(entry.url)),
      ),
    ),
    el(
      'button',
      { class: 'icon-btn', title: 'Reopen in background', 'aria-label': 'Reopen in background', onclick: () => act('restore', { id: entry.id }, 'Reopened') },
      icon('restore'),
    ),
    el(
      'button',
      { class: 'icon-btn danger', title: 'Remove from list', 'aria-label': 'Remove from list', onclick: () => act('forget', { id: entry.id }) },
      icon('x'),
    ),
  );
}

function renderSummary() {
  const { tabs, settings, windowCount } = data;
  const parts = [windowCount > 1 ? `${plural(tabs.length, 'tab')} in ${windowCount} windows` : plural(tabs.length, 'tab')];
  if (!settings.enabled) {
    parts.push('auto-sweep off');
  } else {
    const soon = tabs.filter((t) => !t.protectedBy && !t.held && t.remainingMs <= SOON_MS).length;
    const verb = settings.action === 'discard' ? 'sleeping' : 'closing';
    parts.push(soon ? `${soon} ${verb} within 15m` : `nothing due in 15m`);
  }
  $('summary').textContent = parts.join(' · ');
}

function render() {
  if (!data) return;
  const query = $('search').value.trim().toLowerCase();
  renderSummary();
  $('enabled').checked = data.settings.enabled;
  $('count-open').textContent = data.tabs.length;
  $('count-closed').textContent = data.history.length;

  for (const button of document.querySelectorAll('.views button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === view));
  }
  $('footer-open').hidden = view !== 'open';
  $('footer-closed').hidden = view !== 'closed';

  let rows;
  let emptyText;
  if (view === 'open') {
    const tabs = sortTabs(data.tabs, $('sort').value).filter((t) => matches(query, t.title, t.url));
    rows = tabs.map(openRow);
    emptyText = `No tabs match “${query}”.`;
  } else {
    rows = data.history.filter((e) => matches(query, e.title, e.url)).map(closedRow);
    emptyText = query
      ? `No closed tabs match “${query}”.`
      : 'Nothing here yet. Tabs that Tab Sweeper closes show up here so you can bring them back.';
  }
  $('list').replaceChildren(...rows);
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = emptyText;
  $('sort').hidden = view !== 'open';

  const verb = data.settings.action === 'discard' ? 'Sleep' : 'Sweep';
  $('sweep-now').textContent = data.sweepableCount ? `${verb} ${plural(data.sweepableCount, 'idle tab')}` : 'No idle tabs';
  $('sweep-now').disabled = !data.sweepableCount;
  $('close-dupes').textContent = data.duplicateCount ? `Close ${plural(data.duplicateCount, 'duplicate')}` : 'No duplicates';
  $('close-dupes').disabled = !data.duplicateCount;
  $('clear-history').disabled = !data.history.length;
  $('stats').textContent = `${data.stats.closed} closed · ${data.stats.discarded} put to sleep so far`;
}

async function refresh() {
  try {
    data = await send('overview');
    render();
  } catch (error) {
    $('summary').textContent = error.message;
  }
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

// ---------------------------------------------------------------------------
// Wiring

$('open-options').append(icon('settings'));
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('enabled').addEventListener('change', async (event) => {
  await chrome.storage.sync.set({ enabled: event.target.checked });
  toast(event.target.checked ? 'Auto-sweep on' : 'Auto-sweep off');
  refresh();
});

$('sort').value = pref.get('sort', 'stale');
$('sort').addEventListener('change', () => {
  pref.set('sort', $('sort').value);
  render();
});

$('search').addEventListener('input', render);
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('list').querySelector('.row-main')?.click();
});

for (const button of document.querySelectorAll('.views button')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    $('scroller').scrollTop = 0;
    render();
  });
}

$('sweep-now').addEventListener('click', () =>
  act('sweepNow', {}, (n) => `${data.settings.action === 'discard' ? 'Put to sleep' : 'Closed'} ${plural(n, 'tab')}`),
);
$('close-dupes').addEventListener('click', () => act('closeDuplicates', {}, (n) => `Closed ${plural(n, 'duplicate')}`));
$('clear-history').addEventListener('click', () => act('clearHistory', {}, 'List cleared'));

refresh();
setInterval(refresh, REFRESH_MS);
send('shortcut')
  .then((value) => {
    shortcut = value;
    render();
  })
  .catch(() => {});
