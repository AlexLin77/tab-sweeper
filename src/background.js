// Service worker: tracks when each tab was last used and sweeps idle tabs once a minute.

import {
  LOCK_RESTORE_GRACE_MS,
  claimPendingLocks,
  findDuplicates,
  normalizeSettings,
  planSweep,
  shiftTimestamps,
  snapshotLocks,
  syncTrackedTabs,
} from './policy.js';
import { MINUTE } from './format.js';

const TICK_ALARM = 'tab-sweeper-tick';
const IDLE_DETECTION_SECONDS = 5 * 60; // no input for this long = "away"
const SLEEP_GAP_MS = 3 * MINUTE; // ticks this far apart mean the computer was asleep
const NOT_WORTH_REMEMBERING = new Set(['chrome://newtab/', 'about:blank']);

// ---------------------------------------------------------------------------
// Storage. Every read-modify-write goes through one queue so events can't clobber each other.
// Tab ids only live for one browser session, so usage state lives in storage.session.

let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const emptyState = () => ({
  lastUsed: {},
  kept: [],
  activeByWindow: {},
  lastTick: 0,
  locksRestored: false, // has this session loaded the saved locks yet?
  pendingLocks: [], // saved locks still looking for their restored tab
  pendingUntil: 0,
});

function withState(fn) {
  return exclusive(async () => {
    const state = await chrome.storage.session.get(emptyState());
    const result = await fn(state);
    await chrome.storage.session.set(state);
    return result;
  });
}

function withLocal(fn) {
  return exclusive(async () => {
    const data = await chrome.storage.local.get({ history: [], stats: { closed: 0, discarded: 0 } });
    const result = await fn(data);
    await chrome.storage.local.set(data);
    return result;
  });
}

async function getSettings() {
  return normalizeSettings(await chrome.storage.sync.get(null));
}

const allTabs = () => chrome.tabs.query({ windowType: 'normal' });

const contextFrom = (state, settings, now) => ({
  settings,
  lastUsed: state.lastUsed,
  keptIds: new Set(state.kept),
  now,
});

// ---------------------------------------------------------------------------
// Usage tracking

function touch(tabId) {
  if (tabId == null || tabId < 0) return Promise.resolve();
  return withState((s) => {
    s.lastUsed[tabId] = Date.now();
  });
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  withState((s) => {
    const now = Date.now();
    // The tab you just left starts its countdown now, not when you first opened it.
    const previous = s.activeByWindow[windowId];
    if (previous != null && s.lastUsed[previous] != null) s.lastUsed[previous] = now;
    s.lastUsed[tabId] = now;
    s.activeByWindow[windowId] = tabId;
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  touch(tab.id);
  syncLocksSoon(); // a restored tab may be one that was locked before the restart
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Chrome may drop per-tab badges on navigation; put the lock back on kept tabs.
  if (changeInfo.status === 'loading') {
    chrome.storage.session.get({ kept: [] }).then(({ kept }) => kept.includes(tabId) && showKeptBadge(tabId, true));
  }
  if (changeInfo.url) {
    // Keep saved lock URLs current, and let restored tabs claim their lock once their URL is known.
    chrome.storage.session
      .get({ kept: [], pendingLocks: [] })
      .then(({ kept, pendingLocks }) => (kept.includes(tabId) || pendingLocks.length) && syncLocksSoon());
  }

  // Audio starting or stopping counts as use, so a tab's clock starts when the music stops.
  if (!('audible' in changeInfo)) return;
  getSettings().then((settings) => settings.protectAudible && touch(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withState((s) => {
    delete s.lastUsed[tabId];
    s.kept = s.kept.filter((id) => id !== tabId);
    for (const [windowId, id] of Object.entries(s.activeByWindow)) {
      if (id === tabId) delete s.activeByWindow[windowId];
    }
  });
});

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  withState((s) => {
    if (s.lastUsed[removedId] != null) s.lastUsed[addedId] = s.lastUsed[removedId];
    delete s.lastUsed[removedId];
    s.kept = s.kept.map((id) => (id === removedId ? addedId : id));
    for (const [windowId, id] of Object.entries(s.activeByWindow)) {
      if (id === removedId) s.activeByWindow[windowId] = addedId;
    }
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) touch(tab.id);
});

// ---------------------------------------------------------------------------
// Keeping tabs open: keyboard shortcut and toolbar badge

chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });

async function showKeptBadge(tabId, kept) {
  try {
    await chrome.action.setBadgeText({ tabId, text: kept ? '🔒' : '' });
    await chrome.action.setTitle({ tabId, title: kept ? 'Tab Sweeper: this tab is kept open' : 'Tab Sweeper' });
  } catch {
    // The tab closed in the meantime.
  }
}

// Locks are saved to storage.local so they survive a browser restart or extension reload.
// The saved list is only rewritten from the live tab list (never on tab removal), so the tabs
// closing as Chrome quits can't wipe it, and nothing is saved until the old list has been loaded.

async function reconcileLocks(s, tabs, now) {
  if (!s.locksRestored) {
    const { keptSnapshot = [] } = await chrome.storage.local.get('keptSnapshot');
    s.pendingLocks = keptSnapshot;
    s.pendingUntil = now + LOCK_RESTORE_GRACE_MS;
    s.locksRestored = true;
  }
  return claimPendingLocks(s, tabs, now);
}

function saveLocks(s, tabs, now) {
  return chrome.storage.local.set({ keptSnapshot: snapshotLocks(s, tabs, now) });
}

async function syncLocks() {
  const tabs = await allTabs();
  const claimed = await withState(async (s) => {
    const now = Date.now();
    const ids = await reconcileLocks(s, tabs, now);
    await saveLocks(s, tabs, now);
    return ids;
  });
  await Promise.all(claimed.map((id) => showKeptBadge(id, true)));
}

let syncLocksTimer;
function syncLocksSoon() {
  clearTimeout(syncLocksTimer);
  syncLocksTimer = setTimeout(() => syncLocks().catch((err) => console.error(err)), 1500);
}

/** Toggle "keep open" on the given tab, or on the current tab of the focused window. */
async function toggleKeepCurrentTab(tab) {
  const target = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!target) return null;
  return handlers.toggleKeep({ tabId: target.id });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-keep') toggleKeepCurrentTab(tab).catch((err) => console.error(err));
});

// ---------------------------------------------------------------------------
// Lifecycle. After install, update or browser restart every tab starts with a fresh clock,
// so installing the extension never closes a pile of tabs at once.

async function seedAllTabs() {
  const tabs = await allTabs();
  const now = Date.now();
  await withState((s) => {
    for (const tab of tabs) s.lastUsed[tab.id] = now;
    s.lastTick = now;
  });
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  }
}

const onLaunch = () => seedAllTabs().then(ensureAlarm).then(syncLocks);
chrome.runtime.onInstalled.addListener(onLaunch);
chrome.runtime.onStartup.addListener(onLaunch);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) tick().catch((err) => console.error('Tab Sweeper tick failed', err));
});
ensureAlarm();

// ---------------------------------------------------------------------------
// Sweeping

async function tick() {
  const settings = await getSettings();
  const now = Date.now();
  const [tabs, idleState] = await Promise.all([
    allTabs(),
    settings.pauseWhenAway ? chrome.idle.queryState(IDLE_DETECTION_SECONDS) : 'active',
  ]);

  const { toSweep, claimed } = await withState(async (s) => {
    const gap = s.lastTick ? now - s.lastTick : 0;
    s.lastTick = now;
    const away = settings.pauseWhenAway && (idleState !== 'active' || gap > SLEEP_GAP_MS);
    if (away) shiftTimestamps(s.lastUsed, gap, now); // time away doesn't age tabs
    syncTrackedTabs(s, tabs, now, settings);
    const claimed = await reconcileLocks(s, tabs, now);
    await saveLocks(s, tabs, now);
    if (away || !settings.enabled) return { toSweep: [], claimed };
    return { toSweep: planSweep(tabs, contextFrom(s, settings, now)).toSweep, claimed };
  });

  await Promise.all(claimed.map((id) => showKeptBadge(id, true)));
  return sweepTabs(toSweep, settings.action, 'idle');
}

async function sweepTabs(tabs, action, reason) {
  if (!tabs.length) return 0;
  // Re-check right before acting: you may have switched to one of these tabs a moment ago.
  const current = new Map((await allTabs()).map((tab) => [tab.id, tab]));
  const targets = tabs.map((tab) => current.get(tab.id)).filter((tab) => tab && !tab.active);

  if (action === 'discard') {
    const results = await Promise.allSettled(targets.map((tab) => chrome.tabs.discard(tab.id)));
    const count = results.filter((r) => r.status === 'fulfilled').length;
    if (count) await withLocal((d) => void (d.stats.discarded += count));
    return count;
  }
  return closeTabs(targets, reason);
}

async function closeTabs(tabs, reason) {
  if (!tabs.length) return 0;
  const results = await Promise.allSettled(tabs.map((tab) => chrome.tabs.remove(tab.id)));
  const closed = tabs.filter((_, i) => results[i].status === 'fulfilled');
  const { historyLimit } = await getSettings();
  await withLocal((d) => {
    const closedAt = Date.now();
    const entries = closed
      .map((tab) => ({ tab, url: tab.url || tab.pendingUrl }))
      .filter(({ url }) => url && !NOT_WORTH_REMEMBERING.has(url))
      .map(({ tab, url }) => ({
        id: crypto.randomUUID(),
        url,
        title: tab.title || url,
        windowId: tab.windowId,
        closedAt,
        reason,
      }));
    d.history = [...entries, ...d.history].slice(0, historyLimit);
    d.stats.closed += closed.length;
  });
  return closed.length;
}

// ---------------------------------------------------------------------------
// Messages from the popup

const handlers = {
  async overview() {
    const settings = await getSettings();
    const now = Date.now();
    const [tabs, windows, local, groups] = await Promise.all([
      allTabs(),
      chrome.windows.getAll({ windowTypes: ['normal'] }),
      chrome.storage.local.get({ history: [], stats: { closed: 0, discarded: 0 } }),
      chrome.tabGroups.query({}).catch(() => []),
    ]);
    const { ctx, claimed } = await withState(async (s) => {
      syncTrackedTabs(s, tabs, now, settings);
      const claimed = await reconcileLocks(s, tabs, now);
      return { ctx: contextFrom(s, settings, now), claimed };
    });
    await Promise.all(claimed.map((id) => showKeptBadge(id, true)));
    const plan = planSweep(tabs, ctx);
    return {
      now,
      settings,
      windowCount: windows.length,
      sweepableCount: plan.toSweep.length,
      duplicateCount: findDuplicates(tabs, ctx).length,
      history: local.history,
      stats: local.stats,
      groups: groups.map(({ id, title, color, collapsed, windowId }) => ({ id, title, color, collapsed, windowId })),
      tabs: tabs.map((tab) => {
        const ev = plan.evaluations.get(tab.id);
        return {
          id: tab.id,
          windowId: tab.windowId,
          index: tab.index,
          title: tab.title,
          url: tab.url || tab.pendingUrl || '',
          active: tab.active,
          pinned: tab.pinned,
          discarded: tab.discarded,
          groupId: tab.groupId ?? -1,
          kept: ctx.keptIds.has(tab.id),
          held: plan.held.has(tab.id),
          ...ev,
        };
      }),
    };
  },

  async toggleKeep({ tabId }) {
    const tabs = await allTabs();
    const { kept, claimed } = await withState(async (s) => {
      const now = Date.now();
      const claimed = await reconcileLocks(s, tabs, now); // load saved locks first so we toggle the real state
      const i = s.kept.indexOf(tabId);
      if (i >= 0) s.kept.splice(i, 1);
      else s.kept.push(tabId);
      s.lastUsed[tabId] = now; // un-keeping restarts the clock instead of closing at once
      await saveLocks(s, tabs, now);
      return { kept: i < 0, claimed };
    });
    await Promise.all(claimed.filter((id) => id !== tabId).map((id) => showKeptBadge(id, true)));
    await showKeptBadge(tabId, kept);
    return kept;
  },

  async shortcut() {
    const command = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-keep');
    return command?.shortcut || '';
  },

  async sweepNow() {
    const settings = await getSettings();
    const now = Date.now();
    const tabs = await allTabs();
    const toSweep = await withState((s) => {
      syncTrackedTabs(s, tabs, now, settings);
      return planSweep(tabs, contextFrom(s, settings, now)).toSweep;
    });
    return sweepTabs(toSweep, settings.action, 'idle');
  },

  async closeTab({ tabId }) {
    return closeTabs([await chrome.tabs.get(tabId)], 'manual');
  },

  async closeDuplicates() {
    const tabs = await allTabs();
    const { lastUsed, kept } = await chrome.storage.session.get(emptyState());
    return closeTabs(findDuplicates(tabs, { lastUsed, keptIds: new Set(kept) }), 'duplicate');
  },

  async restore({ id, focus = false }) {
    const entry = await withLocal((d) => {
      const i = d.history.findIndex((e) => e.id === id);
      return i < 0 ? null : d.history.splice(i, 1)[0];
    });
    if (!entry) return false;
    try {
      await chrome.tabs.create({ url: entry.url, windowId: entry.windowId, active: focus });
    } catch {
      await chrome.tabs.create({ url: entry.url, active: focus }); // original window is gone
    }
    return true;
  },

  forget({ id }) {
    return withLocal((d) => void (d.history = d.history.filter((e) => e.id !== id)));
  },

  clearHistory() {
    return withLocal((d) => void (d.history = []));
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message)).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true; // keep the channel open for the async response
});

// Handy from the service worker's DevTools console, and used by the end-to-end test.
globalThis.tabSweeper = { tick, getSettings, withState, handlers, toggleKeepCurrentTab, syncLocks };
