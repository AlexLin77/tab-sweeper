// End-to-end check of Tab Sweeper in a real browser (Chrome for Testing; branded Chrome can't load
// unpacked extensions from the command line).
//   npm install && npm run test:e2e
// Set CHROME_PATH to use a specific Chrome for Testing / Chromium binary. Screenshots go to test/e2e/output/.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const EXT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./output/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const errors = [];
const step = (name) => console.log(`\n▶ ${name}`);
const ok = (msg) => console.log(`  ✔ ${msg}`);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, pipe: true, enableExtensions: [EXT] });
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'));
const sw = await swTarget.worker();
sw.on('console', (m) => m.type() === 'error' && errors.push(`sw: ${m.text()}`));
sw.on('error', (e) => errors.push(`sw: ${e.message}`));
const extId = new URL(swTarget.url()).host;

const run = (fn, ...args) => sw.evaluate(fn, ...args);
const tabs = () => run(() => chrome.tabs.query({ windowType: 'normal' }));
// Give the onInstalled seeding a moment
await new Promise((r) => setTimeout(r, 500));

step('service worker boots');
assert.equal(await run(() => typeof globalThis.tabSweeper?.tick), 'function');
assert.ok(await run(() => chrome.alarms.get('tab-sweeper-tick')), 'tick alarm registered');
ok(`extension ${extId} loaded, alarm registered`);

step('close idle tabs, respecting active, kept and min-tabs');
for (let i = 1; i <= 6; i++) {
  const page = await browser.newPage();
  await page.goto(`data:text/html,<title>Page ${i}</title><h1>${i}</h1>`);
}
await run(() => chrome.storage.sync.set({ idleMinutes: 1, minTabsPerWindow: 3, pauseWhenAway: false }));
let all = await tabs();
const active = all.find((t) => t.active);
const keep = all.find((t) => t.title === 'Page 2');
await run((id) => tabSweeper.handlers.toggleKeep({ tabId: id }), keep.id);
// Age every tab: Page N idle for (10 + N) minutes, about:blank for 5 minutes
await run(
  (list) =>
    tabSweeper.withState((s) => {
      for (const t of list) {
        const n = Number(t.title.match(/\d+/)?.[0] ?? 0);
        s.lastUsed[t.id] = Date.now() - (n ? 10 + n : 5) * 60_000;
      }
    }),
  all,
);
const closedCount = await run(() => tabSweeper.tick());
all = await tabs();
const titles = all.map((t) => t.title).sort();
console.log('  remaining:', titles.join(', '));
assert.equal(all.length, 3, 'min 3 tabs kept in the window');
assert.ok(all.some((t) => t.id === active.id), 'active tab survives');
assert.ok(all.some((t) => t.id === keep.id), 'kept tab survives');
assert.ok(all.some((t) => t.url === 'about:blank'), 'least-idle eligible tab is held by min-tabs');
assert.equal(closedCount, 4);
let { history, stats } = await run(() => chrome.storage.local.get(['history', 'stats']));
assert.equal(history.length, 4);
assert.equal(stats.closed, 4);
assert.ok(history.every((h) => h.reason === 'idle' && h.url.startsWith('data:')));
ok(`closed ${closedCount}, history recorded`);

step('restore from history');
const restoredTitle = history[0].title;
await run((id) => tabSweeper.handlers.restore({ id }), history[0].id);
await new Promise((r) => setTimeout(r, 500));
all = await tabs();
assert.ok(all.some((t) => t.title === restoredTitle), 'restored tab reopened');
({ history } = await run(() => chrome.storage.local.get('history')));
assert.equal(history.length, 3);
ok(`reopened "${restoredTitle}"`);

step('close duplicates');
for (let i = 0; i < 2; i++) {
  const p = await browser.newPage();
  await p.goto(`data:text/html,<title>Dup</title>dup`);
}
const dupes = await run(() => tabSweeper.handlers.closeDuplicates());
all = await tabs();
assert.equal(dupes, 1);
assert.equal(all.filter((t) => t.title === 'Dup').length, 1);
ok('one duplicate closed, one kept');

step('time away does not age tabs');
await run(() => chrome.storage.sync.set({ pauseWhenAway: true, minTabsPerWindow: 0 }));
const before = (await tabs()).length;
await run(() =>
  tabSweeper.withState((s) => {
    const now = Date.now();
    for (const id of Object.keys(s.lastUsed)) s.lastUsed[id] = now - 20 * 60_000; // idle 20 min...
    s.lastTick = now - 30 * 60_000; // ...but the computer was asleep for the last 30
  }),
);
assert.equal(await run(() => tabSweeper.tick()), 0);
assert.equal((await tabs()).length, before);
ok('nothing swept after a 30-minute sleep gap');

step('sleep (discard) mode');
await run(() => chrome.storage.sync.set({ action: 'discard', pauseWhenAway: false }));
await run(() =>
  tabSweeper.withState((s) => {
    for (const id of Object.keys(s.lastUsed)) s.lastUsed[id] = Date.now() - 20 * 60_000;
  }),
);
const discarded = await run(() => tabSweeper.tick());
all = await tabs();
assert.equal(all.length, before, 'no tabs closed in discard mode');
assert.ok(discarded > 0, 'some tabs discarded');
assert.equal(all.filter((t) => t.discarded).length, discarded);
ok(`${discarded} tabs put to sleep, none closed`);

step('popup and options render');
await run(() => chrome.storage.sync.set({ action: 'close', idleMinutes: 120, minTabsPerWindow: 3 }));
for (let i = 7; i <= 10; i++) {
  const p = await browser.newPage();
  await p.goto(`data:text/html,<title>Research tab ${i}</title>x`);
}
await run(() =>
  tabSweeper.withState((s) => {
    const ages = [3, 95, 112, 125, 400, 30, 7, 60, 200, 15, 1];
    Object.keys(s.lastUsed).forEach((id, i) => (s.lastUsed[id] = Date.now() - (ages[i % ages.length]) * 60_000));
  }),
);
const pinTarget = (await tabs()).find((t) => t.title === 'Research tab 8');
await run((id) => chrome.tabs.update(id, { pinned: true }), pinTarget.id);

for (const scheme of ['light', 'dark']) {
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
  popup.on('console', (m) => m.type() === 'error' && errors.push(`popup: ${m.text()}`));
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await popup.setViewport({ width: 400, height: 560, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/src/popup.html`);
  await popup.waitForSelector('#list .row');
  const rowCount = await popup.$$eval('#list .row', (rows) => rows.length);
  const summary = await popup.$eval('#summary', (n) => n.textContent);
  console.log(`  [${scheme}] rows=${rowCount} summary="${summary}"`);
  await popup.screenshot({ path: `${OUT}popup-${scheme}.png` });
  if (scheme === 'light') {
    await popup.click('[data-view="closed"]');
    await popup.waitForSelector('#list .row');
    await popup.screenshot({ path: `${OUT}popup-closed.png` });
    await popup.type('#search', 'zzz-no-match');
    assert.equal(await popup.$eval('#empty', (n) => n.hidden), false);
  }
  await popup.close();
}

const options = await browser.newPage();
await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
options.on('pageerror', (e) => errors.push(`options: ${e.message}`));
await options.setViewport({ width: 760, height: 1400 });
await options.goto(`chrome-extension://${extId}/src/options.html`);
await options.waitForFunction(() => document.querySelector('#idle-amount').value !== '');
assert.equal(await options.$eval('#idle-amount', (n) => n.value), '2');
assert.equal(await options.$eval('select[name=idleUnit]', (n) => n.value), '60');
// Edit the whitelist and check it is normalized and saved
await options.type('#whitelist', 'https://Mail.Google.com/\n*.slack.com');
await options.click('h1'); // blur => change
await options.waitForFunction(() => document.querySelector('#saved').classList.contains('show'));
const saved = await run(() => chrome.storage.sync.get('whitelist'));
assert.deepEqual(saved.whitelist, ['mail.google.com', 'slack.com']);
await options.screenshot({ path: `${OUT}options.png`, fullPage: true });
ok('popup (light/dark/closed view) and options rendered; whitelist saved normalized');

step('keep-open keyboard shortcut');
const command = (await run(() => chrome.commands.getAll())).find((c) => c.name === 'toggle-keep');
assert.ok(command, 'toggle-keep command registered');
console.log(`  shortcut: "${command.shortcut}"`);
assert.ok(command.shortcut, 'a default shortcut is assigned');
const target = await browser.newPage();
await target.goto('data:text/html,<title>Shortcut target</title>x');
await target.bringToFront();
const targetTab = (await tabs()).find((t) => t.title === 'Shortcut target');
const badge = () => run((id) => chrome.action.getBadgeText({ tabId: id }), targetTab.id);
const isKept = async () => (await run(() => chrome.storage.session.get('kept'))).kept.includes(targetTab.id);

assert.equal(await run(() => tabSweeper.toggleKeepCurrentTab()), true, 'shortcut locks the current tab');
assert.ok(await isKept());
assert.equal(await badge(), '🔒');
await target.goto('data:text/html,<title>Shortcut target, page 2</title>y');
await new Promise((r) => setTimeout(r, 300));
assert.equal(await badge(), '🔒', 'badge survives navigation');

// A locked tab survives a sweep even when it is very stale
await target.bringToFront();
const other = await browser.newPage();
await other.goto('data:text/html,<title>Other</title>z');
await run(() => chrome.storage.sync.set({ idleMinutes: 1, minTabsPerWindow: 0, pauseWhenAway: false }));
await run((id) => tabSweeper.withState((s) => void (s.lastUsed[id] = Date.now() - 600 * 60_000)), targetTab.id);
await run(() => tabSweeper.tick());
assert.ok((await tabs()).some((t) => t.id === targetTab.id), 'locked tab not swept');
await run(() => chrome.storage.sync.set({ idleMinutes: 120, minTabsPerWindow: 3 }));

await target.bringToFront();
assert.equal(await run(() => tabSweeper.toggleKeepCurrentTab()), false, 'pressing again unlocks');
assert.ok(!(await isKept()));
assert.equal(await badge(), '');

const optionsAgain = await browser.newPage();
await optionsAgain.goto(`chrome-extension://${extId}/src/options.html`);
await optionsAgain.waitForFunction(() => document.querySelector('#shortcut').textContent !== '');
assert.equal(await optionsAgain.$eval('#shortcut', (n) => n.textContent), command.shortcut);
assert.equal(await optionsAgain.$eval('#change-shortcut', (n) => n.textContent), 'Change shortcut');
await optionsAgain.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
const hint = await optionsAgain.$('.hint');
await hint.screenshot({ path: `${OUT}options-shortcut-hint.png` });

const popupAgain = await browser.newPage();
await popupAgain.goto(`chrome-extension://${extId}/src/popup.html`);
await popupAgain.waitForFunction(() => document.querySelector('.is-active .keep')?.title.includes('('));
console.log(`  popup tooltip: "${await popupAgain.$eval('.is-active .keep', (n) => n.title)}"`);
ok('shortcut locks/unlocks the current tab, badge shown and kept across navigation, hints shown');

await browser.close();
if (errors.length) {
  console.error('\nErrors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
