// Pure decision logic: which tabs are idle, which are protected, which get swept.
// Nothing in this file touches chrome.* so it can be unit-tested in Node.

import { MINUTE } from './format.js';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  idleMinutes: 120,
  action: 'close', // 'close' | 'discard'
  minTabsPerWindow: 3,
  protectPinned: true,
  protectAudible: true,
  protectGrouped: false,
  pauseWhenAway: true,
  whitelist: Object.freeze([]),
  historyLimit: 200,
});

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Merge stored settings over defaults and coerce every field into a valid value. */
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  return {
    enabled: Boolean(s.enabled),
    idleMinutes: Math.round(clampNumber(s.idleMinutes, 1, 60 * 24 * 30, DEFAULT_SETTINGS.idleMinutes)),
    action: s.action === 'discard' ? 'discard' : 'close',
    minTabsPerWindow: Math.round(clampNumber(s.minTabsPerWindow, 0, 100, DEFAULT_SETTINGS.minTabsPerWindow)),
    protectPinned: Boolean(s.protectPinned),
    protectAudible: Boolean(s.protectAudible),
    protectGrouped: Boolean(s.protectGrouped),
    pauseWhenAway: Boolean(s.pauseWhenAway),
    whitelist: parseWhitelist(s.whitelist),
    historyLimit: Math.round(clampNumber(s.historyLimit, 0, 1000, DEFAULT_SETTINGS.historyLimit)),
  };
}

/**
 * Accepts an array or free text (newline/comma separated) and returns clean entries like
 * "example.com" or "github.com/my-org". Protocols, "*." prefixes and trailing slashes are dropped.
 */
export function parseWhitelist(input) {
  const items = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]/);
  const cleaned = items
    .map((item) =>
      String(item)
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/^\*\./, '')
        .replace(/\/+$/, ''),
    )
    .filter(Boolean);
  return [...new Set(cleaned)];
}

/** True when the URL's host is (a subdomain of) an entry, and its path is under the entry's path if it has one. */
export function matchesWhitelist(url, whitelist) {
  if (!url || !whitelist?.length) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  return whitelist.some((entry) => {
    const slash = entry.indexOf('/');
    const entryHost = (slash === -1 ? entry : entry.slice(0, slash)).replace(/:\d+$/, '');
    const entryPath = slash === -1 ? '' : entry.slice(slash);
    if (!entryHost) return false;
    if (host !== entryHost && !host.endsWith(`.${entryHost}`)) return false;
    return !entryPath || path === entryPath || path.startsWith(`${entryPath}/`);
  });
}

/**
 * Decide what to do with one tab.
 * ctx = { settings, lastUsed: {[tabId]: ms}, keptIds: Set<tabId>, now }
 * Returns { idleMs, remainingMs, protectedBy: string|null, eligible: boolean }.
 */
export function evaluateTab(tab, ctx) {
  const { settings, lastUsed, keptIds, now } = ctx;
  const last = lastUsed[tab.id];
  const idleMs = last == null ? 0 : Math.max(0, now - last);
  const thresholdMs = settings.idleMinutes * MINUTE;
  const url = tab.url || tab.pendingUrl || '';

  let protectedBy = null;
  if (tab.active) protectedBy = 'active';
  else if (keptIds.has(tab.id)) protectedBy = 'kept';
  else if (settings.protectPinned && tab.pinned) protectedBy = 'pinned';
  else if (settings.protectAudible && tab.audible) protectedBy = 'audible';
  else if (settings.protectGrouped && tab.groupId != null && tab.groupId !== -1) protectedBy = 'grouped';
  else if (matchesWhitelist(url, settings.whitelist)) protectedBy = 'whitelist';
  else if (settings.action === 'discard' && tab.discarded) protectedBy = 'discarded';
  else if (last == null) protectedBy = 'untracked';

  return {
    idleMs,
    remainingMs: Math.max(0, thresholdMs - idleMs),
    protectedBy,
    eligible: protectedBy === null && idleMs >= thresholdMs,
  };
}

/**
 * Pick the tabs to sweep now. Within each window the stalest tabs go first, and when closing,
 * a window never drops below settings.minTabsPerWindow tabs (the rest are reported as `held`).
 */
export function planSweep(tabs, ctx) {
  const evaluations = new Map();
  const windows = new Map();
  for (const tab of tabs) {
    evaluations.set(tab.id, evaluateTab(tab, ctx));
    if (!windows.has(tab.windowId)) windows.set(tab.windowId, []);
    windows.get(tab.windowId).push(tab);
  }

  const toSweep = [];
  const held = new Set();
  for (const windowTabs of windows.values()) {
    const candidates = windowTabs
      .filter((tab) => evaluations.get(tab.id).eligible)
      .sort((a, b) => evaluations.get(b.id).idleMs - evaluations.get(a.id).idleMs);
    const budget =
      ctx.settings.action === 'close'
        ? Math.max(0, windowTabs.length - ctx.settings.minTabsPerWindow)
        : candidates.length;
    candidates.forEach((tab, i) => (i < budget ? toSweep.push(tab) : held.add(tab.id)));
  }
  return { toSweep, held, evaluations };
}

/** URL identity for duplicate detection: the same page with a different #fragment counts as a duplicate. */
export function dedupeKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Tabs that duplicate another open tab. In each group we keep the active tab, then a pinned one,
 * then a kept one, then the most recently used. Active, pinned and kept tabs are never returned.
 */
export function findDuplicates(tabs, { lastUsed = {}, keptIds = new Set() } = {}) {
  const groups = new Map();
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    if (!url) continue;
    const key = dedupeKey(url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }

  const rank = (tab) => [
    tab.active ? 1 : 0,
    tab.pinned ? 1 : 0,
    keptIds.has(tab.id) ? 1 : 0,
    lastUsed[tab.id] ?? tab.lastAccessed ?? 0,
  ];
  const compare = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };

  const duplicates = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => compare(rank(a), rank(b)));
    for (const tab of sorted.slice(1)) {
      if (!tab.active && !tab.pinned && !keptIds.has(tab.id)) duplicates.push(tab);
    }
  }
  return duplicates;
}

/**
 * Reconcile tracked state with the tabs that are actually open (mutates `state`):
 * forget closed tabs, start the clock for unknown tabs, and mark tabs that are in use right now.
 * state = { lastUsed, kept, activeByWindow }
 */
export function syncTrackedTabs(state, tabs, now, settings) {
  const live = new Set(tabs.map((tab) => String(tab.id)));
  for (const id of Object.keys(state.lastUsed)) if (!live.has(id)) delete state.lastUsed[id];
  state.kept = state.kept.filter((id) => live.has(String(id)));
  for (const [windowId, tabId] of Object.entries(state.activeByWindow)) {
    if (!live.has(String(tabId))) delete state.activeByWindow[windowId];
  }
  for (const tab of tabs) {
    const inUse = tab.active || (settings.protectAudible && tab.audible);
    if (inUse || state.lastUsed[tab.id] == null) state.lastUsed[tab.id] = now;
    if (tab.active) state.activeByWindow[tab.windowId] = tab.id;
  }
}

// ---------------------------------------------------------------------------
// Keeping locks across browser restarts. Tab ids change on restart, so locks are saved as
// { tabId, url, window, index } and matched back to restored tabs by URL, using window order and
// tab position (and the old id, which survives an extension reload) to break ties.

/** How long after a restart unmatched locks wait for their tab to be restored. */
export const LOCK_RESTORE_GRACE_MS = 10 * MINUTE;

const tabUrl = (tab) => tab.url || tab.pendingUrl || '';

/** windowId -> 0-based position of that window (by id, i.e. creation order). */
export function windowOrdinals(tabs) {
  const ids = [...new Set(tabs.map((tab) => tab.windowId))].sort((a, b) => a - b);
  return new Map(ids.map((id, i) => [id, i]));
}

/** What to save: every kept tab, plus restored locks still waiting for their tab. */
export function snapshotLocks(state, tabs, now) {
  const ordinals = windowOrdinals(tabs);
  const kept = new Set(state.kept);
  const entries = tabs
    .filter((tab) => kept.has(tab.id) && tabUrl(tab))
    .map((tab) => ({ tabId: tab.id, url: tabUrl(tab), window: ordinals.get(tab.windowId), index: tab.index }));
  const waiting = now < (state.pendingUntil ?? 0) ? (state.pendingLocks ?? []) : [];
  return [...entries, ...waiting];
}

/**
 * Match saved locks (state.pendingLocks) to open tabs with the same URL and add those tabs to
 * state.kept (mutates `state`). Returns the newly kept tab ids. Once the grace period is over,
 * locks that never found their tab are dropped.
 */
export function claimPendingLocks(state, tabs, now) {
  if (!state.pendingLocks?.length) return [];
  if (now >= state.pendingUntil) {
    state.pendingLocks = [];
    return [];
  }
  const ordinals = windowOrdinals(tabs);
  const taken = new Set(state.kept);
  const claimed = [];
  const waiting = [];
  for (const entry of state.pendingLocks) {
    const rank = (tab) => [
      tab.id === entry.tabId ? 0 : 1,
      ordinals.get(tab.windowId) === entry.window ? 0 : 1,
      Math.abs(tab.index - entry.index),
    ];
    const best = tabs
      .filter((tab) => !taken.has(tab.id) && tabUrl(tab) === entry.url)
      .map((tab) => ({ tab, rank: rank(tab) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])[0];
    if (!best) {
      waiting.push(entry);
      continue;
    }
    taken.add(best.tab.id);
    claimed.push(best.tab.id);
  }
  state.kept.push(...claimed);
  state.pendingLocks = waiting;
  return claimed;
}

/** Push every timestamp forward by `deltaMs` (capped at `now`) so time spent away doesn't age tabs. */
export function shiftTimestamps(lastUsed, deltaMs, now) {
  if (!(deltaMs > 0)) return;
  for (const id of Object.keys(lastUsed)) lastUsed[id] = Math.min(now, lastUsed[id] + deltaMs);
}
