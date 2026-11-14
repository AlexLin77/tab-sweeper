import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MINUTE } from '../src/format.js';
import {
  DEFAULT_SETTINGS,
  dedupeKey,
  evaluateTab,
  findDuplicates,
  matchesWhitelist,
  normalizeSettings,
  parseWhitelist,
  planSweep,
  LOCK_RESTORE_GRACE_MS,
  claimPendingLocks,
  shiftTimestamps,
  snapshotLocks,
  syncTrackedTabs,
} from '../src/policy.js';

const NOW = 1_700_000_000_000;

const makeTab = (id, overrides = {}) => ({
  id,
  windowId: 1,
  index: id,
  url: `https://example.com/page/${id}`,
  title: `Tab ${id}`,
  active: false,
  pinned: false,
  audible: false,
  discarded: false,
  groupId: -1,
  ...overrides,
});

const makeCtx = ({ settings = {}, lastUsed = {}, kept = [] } = {}) => ({
  settings: normalizeSettings({ idleMinutes: 60, minTabsPerWindow: 0, ...settings }),
  lastUsed,
  keptIds: new Set(kept),
  now: NOW,
});

const ago = (minutes) => NOW - minutes * MINUTE;

describe('normalizeSettings', () => {
  test('returns defaults for empty input', () => {
    assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS, whitelist: [] });
  });

  test('clamps numbers and rejects junk', () => {
    const s = normalizeSettings({ idleMinutes: 0, minTabsPerWindow: -4, historyLimit: 'lots', action: 'explode' });
    assert.equal(s.idleMinutes, 1);
    assert.equal(s.minTabsPerWindow, 0);
    assert.equal(s.historyLimit, DEFAULT_SETTINGS.historyLimit);
    assert.equal(s.action, 'close');
  });

  test('accepts numeric strings and rounds', () => {
    const s = normalizeSettings({ idleMinutes: '90.4', minTabsPerWindow: '2', action: 'discard' });
    assert.equal(s.idleMinutes, 90);
    assert.equal(s.minTabsPerWindow, 2);
    assert.equal(s.action, 'discard');
  });

  test('parses a free-text whitelist', () => {
    assert.deepEqual(normalizeSettings({ whitelist: 'a.com\nb.com' }).whitelist, ['a.com', 'b.com']);
  });
});

describe('parseWhitelist', () => {
  test('cleans protocols, wildcards, trailing slashes, case and duplicates', () => {
    assert.deepEqual(
      parseWhitelist('https://Mail.Google.com/\n*.slack.com, github.com/my-org/ \n\n mail.google.com'),
      ['mail.google.com', 'slack.com', 'github.com/my-org'],
    );
  });

  test('handles arrays and empty input', () => {
    assert.deepEqual(parseWhitelist(['  x.com  ', '']), ['x.com']);
    assert.deepEqual(parseWhitelist(undefined), []);
  });
});

describe('matchesWhitelist', () => {
  const list = ['google.com', 'github.com/my-org', 'localhost:3000'];

  test('matches a domain and its subdomains', () => {
    assert.ok(matchesWhitelist('https://google.com/', list));
    assert.ok(matchesWhitelist('https://mail.google.com/u/0', list));
  });

  test('does not match look-alike domains', () => {
    assert.ok(!matchesWhitelist('https://notgoogle.com/', list));
    assert.ok(!matchesWhitelist('https://google.com.evil.io/', list));
  });

  test('respects path boundaries', () => {
    assert.ok(matchesWhitelist('https://github.com/my-org', list));
    assert.ok(matchesWhitelist('https://github.com/my-org/repo/pulls', list));
    assert.ok(!matchesWhitelist('https://github.com/my-org-fork', list));
    assert.ok(!matchesWhitelist('https://github.com/other', list));
  });

  test('ignores ports in entries and bad URLs', () => {
    assert.ok(matchesWhitelist('http://localhost:3000/app', list));
    assert.ok(!matchesWhitelist('not a url', list));
    assert.ok(!matchesWhitelist('', list));
    assert.ok(!matchesWhitelist('https://google.com', []));
  });
});

describe('evaluateTab', () => {
  test('a tab idle past the threshold is eligible', () => {
    const ev = evaluateTab(makeTab(1), makeCtx({ lastUsed: { 1: ago(61) } }));
    assert.equal(ev.eligible, true);
    assert.equal(ev.protectedBy, null);
    assert.equal(ev.remainingMs, 0);
  });

  test('a tab under the threshold reports time remaining', () => {
    const ev = evaluateTab(makeTab(1), makeCtx({ lastUsed: { 1: ago(45) } }));
    assert.equal(ev.eligible, false);
    assert.equal(ev.remainingMs, 15 * MINUTE);
  });

  test('exactly at the threshold is eligible', () => {
    assert.equal(evaluateTab(makeTab(1), makeCtx({ lastUsed: { 1: ago(60) } })).eligible, true);
  });

  const old = { 1: ago(500) };
  const cases = [
    ['active', { active: true }, {}],
    ['kept', {}, { kept: [1] }],
    ['pinned', { pinned: true }, {}],
    ['audible', { audible: true }, {}],
    ['grouped', { groupId: 7 }, { settings: { protectGrouped: true } }],
    ['whitelist', { url: 'https://docs.example.org/x' }, { settings: { whitelist: ['example.org'] } }],
    ['discarded', { discarded: true }, { settings: { action: 'discard' } }],
  ];
  for (const [reason, tabProps, ctxProps] of cases) {
    test(`protects ${reason} tabs`, () => {
      const ev = evaluateTab(makeTab(1, tabProps), makeCtx({ lastUsed: old, ...ctxProps }));
      assert.equal(ev.protectedBy, reason);
      assert.equal(ev.eligible, false);
    });
  }

  test('protections can be turned off', () => {
    const ctx = makeCtx({ lastUsed: old, settings: { protectPinned: false, protectAudible: false } });
    assert.equal(evaluateTab(makeTab(1, { pinned: true }), ctx).eligible, true);
    assert.equal(evaluateTab(makeTab(1, { audible: true }), ctx).eligible, true);
    assert.equal(evaluateTab(makeTab(1, { groupId: 3 }), ctx).eligible, true); // grouped is off by default
  });

  test('discarded tabs can still be closed in close mode', () => {
    assert.equal(evaluateTab(makeTab(1, { discarded: true }), makeCtx({ lastUsed: old })).eligible, true);
  });

  test('never sweeps a tab it has no record of', () => {
    const ev = evaluateTab(makeTab(1), makeCtx());
    assert.equal(ev.protectedBy, 'untracked');
    assert.equal(ev.eligible, false);
  });

  test('uses pendingUrl when url is missing', () => {
    const tab = makeTab(1, { url: undefined, pendingUrl: 'https://keep.me/' });
    const ev = evaluateTab(tab, makeCtx({ lastUsed: old, settings: { whitelist: ['keep.me'] } }));
    assert.equal(ev.protectedBy, 'whitelist');
  });
});

describe('planSweep', () => {
  test('sweeps only eligible tabs, stalest first', () => {
    const tabs = [makeTab(1), makeTab(2), makeTab(3), makeTab(4, { active: true })];
    const lastUsed = { 1: ago(90), 2: ago(300), 3: ago(10), 4: ago(999) };
    const { toSweep, held } = planSweep(tabs, makeCtx({ lastUsed }));
    assert.deepEqual(toSweep.map((t) => t.id), [2, 1]);
    assert.equal(held.size, 0);
  });

  test('keeps a minimum number of tabs per window when closing', () => {
    const tabs = [1, 2, 3, 4, 5].map((id) => makeTab(id, { active: id === 5 }));
    const lastUsed = { 1: ago(100), 2: ago(400), 3: ago(200), 4: ago(300), 5: NOW };
    const { toSweep, held } = planSweep(tabs, makeCtx({ lastUsed, settings: { minTabsPerWindow: 3 } }));
    assert.deepEqual(toSweep.map((t) => t.id), [2, 4]); // 5 tabs - 3 minimum = 2 may close
    assert.deepEqual([...held].sort(), [1, 3]);
  });

  test('applies the minimum to each window separately', () => {
    const tabs = [
      makeTab(1, { windowId: 1 }),
      makeTab(2, { windowId: 1, active: true }),
      makeTab(3, { windowId: 2 }),
      makeTab(4, { windowId: 2 }),
      makeTab(5, { windowId: 2, active: true }),
    ];
    const lastUsed = { 1: ago(100), 2: NOW, 3: ago(100), 4: ago(100), 5: NOW };
    const { toSweep } = planSweep(tabs, makeCtx({ lastUsed, settings: { minTabsPerWindow: 2 } }));
    assert.deepEqual(toSweep.map((t) => t.id).sort(), [3]);
  });

  test('the minimum does not apply to sleeping tabs (they stay open)', () => {
    const tabs = [makeTab(1), makeTab(2), makeTab(3, { active: true })];
    const lastUsed = { 1: ago(100), 2: ago(100), 3: NOW };
    const { toSweep } = planSweep(tabs, makeCtx({ lastUsed, settings: { minTabsPerWindow: 10, action: 'discard' } }));
    assert.equal(toSweep.length, 2);
  });

  test('returns an evaluation for every tab', () => {
    const tabs = [makeTab(1), makeTab(2)];
    const { evaluations } = planSweep(tabs, makeCtx({ lastUsed: { 1: NOW, 2: NOW } }));
    assert.equal(evaluations.size, 2);
  });
});

describe('findDuplicates', () => {
  test('keeps the most recently used copy and ignores #fragments', () => {
    const tabs = [
      makeTab(1, { url: 'https://a.com/x' }),
      makeTab(2, { url: 'https://a.com/x#section' }),
      makeTab(3, { url: 'https://a.com/x' }),
      makeTab(4, { url: 'https://a.com/y' }),
    ];
    const lastUsed = { 1: ago(50), 2: ago(5), 3: ago(500), 4: ago(1) };
    assert.deepEqual(findDuplicates(tabs, { lastUsed }).map((t) => t.id).sort(), [1, 3]);
  });

  test('prefers the active tab and never returns active, pinned or kept tabs', () => {
    const tabs = [
      makeTab(1, { url: 'https://a.com/', active: true }),
      makeTab(2, { url: 'https://a.com/' }),
      makeTab(3, { url: 'https://a.com/', pinned: true }),
      makeTab(4, { url: 'https://a.com/' }),
    ];
    const lastUsed = { 1: ago(100), 2: NOW, 3: NOW, 4: NOW };
    assert.deepEqual(findDuplicates(tabs, { lastUsed, keptIds: new Set([4]) }).map((t) => t.id), [2]);
  });

  test('two active copies in different windows are both kept', () => {
    const tabs = [
      makeTab(1, { url: 'https://a.com/', active: true, windowId: 1 }),
      makeTab(2, { url: 'https://a.com/', active: true, windowId: 2 }),
    ];
    assert.deepEqual(findDuplicates(tabs), []);
  });

  test('dedupeKey tolerates non-URLs', () => {
    assert.equal(dedupeKey('https://a.com/p?q=1#h'), 'https://a.com/p?q=1');
    assert.equal(dedupeKey('???'), '???');
  });
});

describe('syncTrackedTabs', () => {
  const settings = normalizeSettings({});

  test('forgets closed tabs, seeds new ones and marks in-use tabs', () => {
    const state = { lastUsed: { 1: ago(30), 2: ago(30), 99: ago(30) }, kept: [2, 99], activeByWindow: { 1: 99 } };
    const tabs = [makeTab(1), makeTab(2, { active: true }), makeTab(3), makeTab(4, { audible: true })];
    syncTrackedTabs(state, tabs, NOW, settings);
    assert.deepEqual(state.lastUsed, { 1: ago(30), 2: NOW, 3: NOW, 4: NOW });
    assert.deepEqual(state.kept, [2]);
    assert.deepEqual(state.activeByWindow, { 1: 2 });
  });

  test('audio only counts as use when audible tabs are protected', () => {
    const state = { lastUsed: { 1: ago(30) }, kept: [], activeByWindow: {} };
    syncTrackedTabs(state, [makeTab(1, { audible: true })], NOW, normalizeSettings({ protectAudible: false }));
    assert.equal(state.lastUsed[1], ago(30));
  });
});

describe('shiftTimestamps', () => {
  test('moves timestamps forward but never past now', () => {
    const lastUsed = { 1: ago(100), 2: ago(10) };
    shiftTimestamps(lastUsed, 30 * MINUTE, NOW);
    assert.deepEqual(lastUsed, { 1: ago(70), 2: NOW });
  });

  test('ignores zero or negative gaps', () => {
    const lastUsed = { 1: ago(100) };
    shiftTimestamps(lastUsed, 0, NOW);
    shiftTimestamps(lastUsed, -5, NOW);
    assert.deepEqual(lastUsed, { 1: ago(100) });
  });
});

describe('locks across restarts', () => {
  const lockState = (overrides = {}) => ({
    kept: [],
    pendingLocks: [],
    pendingUntil: NOW + LOCK_RESTORE_GRACE_MS,
    ...overrides,
  });

  test('snapshot records kept tabs with window order and position', () => {
    const tabs = [
      makeTab(10, { windowId: 5, index: 0 }),
      makeTab(11, { windowId: 5, index: 1 }),
      makeTab(20, { windowId: 9, index: 0, url: 'https://b.com/' }),
    ];
    const snap = snapshotLocks(lockState({ kept: [11, 20] }), tabs, NOW);
    assert.deepEqual(snap, [
      { tabId: 11, url: 'https://example.com/page/11', window: 0, index: 1 },
      { tabId: 20, url: 'https://b.com/', window: 1, index: 0 },
    ]);
  });

  test('snapshot keeps unmatched restored locks only during the grace period', () => {
    const waiting = { tabId: 1, url: 'https://gone.com/', window: 0, index: 0 };
    assert.deepEqual(snapshotLocks(lockState({ pendingLocks: [waiting] }), [], NOW), [waiting]);
    const expired = lockState({ pendingLocks: [waiting], pendingUntil: NOW - 1 });
    assert.deepEqual(snapshotLocks(expired, [], NOW), []);
  });

  test('restored tabs with new ids are matched by URL', () => {
    const state = lockState({
      pendingLocks: [{ tabId: 3, url: 'https://a.com/', window: 0, index: 2 }],
    });
    const tabs = [makeTab(101, { url: 'https://x.com/' }), makeTab(102, { url: 'https://a.com/', index: 2 })];
    assert.deepEqual(claimPendingLocks(state, tabs, NOW), [102]);
    assert.deepEqual(state.kept, [102]);
    assert.deepEqual(state.pendingLocks, []);
  });

  test('ties go to the same window and nearest position, and each tab is claimed once', () => {
    const url = 'https://same.com/';
    const state = lockState({
      pendingLocks: [
        { tabId: 1, url, window: 1, index: 3 },
        { tabId: 2, url, window: 0, index: 0 },
      ],
    });
    const tabs = [
      makeTab(50, { url, windowId: 7, index: 0 }),
      makeTab(51, { url, windowId: 8, index: 0 }),
      makeTab(52, { url, windowId: 8, index: 4 }),
    ];
    assert.deepEqual(claimPendingLocks(state, tabs, NOW), [52, 50]);
  });

  test('the old tab id wins when it still exists (extension reload)', () => {
    const url = 'https://same.com/';
    const state = lockState({ pendingLocks: [{ tabId: 61, url, window: 0, index: 0 }] });
    const tabs = [makeTab(60, { url, index: 0 }), makeTab(61, { url, index: 5 })];
    assert.deepEqual(claimPendingLocks(state, tabs, NOW), [61]);
  });

  test('locks wait for tabs that are not restored yet, then expire', () => {
    const entry = { tabId: 1, url: 'https://later.com/', window: 0, index: 0 };
    const state = lockState({ pendingLocks: [entry] });
    assert.deepEqual(claimPendingLocks(state, [makeTab(5)], NOW), []);
    assert.deepEqual(state.pendingLocks, [entry]);

    const later = [makeTab(5), makeTab(6, { url: 'https://later.com/' })];
    assert.deepEqual(claimPendingLocks(state, later, NOW + MINUTE), [6]);

    const stale = lockState({ pendingLocks: [entry] });
    assert.deepEqual(claimPendingLocks(stale, later, NOW + LOCK_RESTORE_GRACE_MS), []);
    assert.deepEqual(stale.pendingLocks, []);
  });

  test('tabs that are already kept are not claimed twice', () => {
    const state = lockState({ kept: [7], pendingLocks: [{ tabId: 1, url: 'https://a.com/', window: 0, index: 0 }] });
    assert.deepEqual(claimPendingLocks(state, [makeTab(7, { url: 'https://a.com/' })], NOW), []);
    assert.deepEqual(state.kept, [7]);
  });
});
