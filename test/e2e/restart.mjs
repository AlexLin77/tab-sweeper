// End-to-end check that locked tabs stay locked across a real browser restart (with session
// restore) and across an extension reload.   npm install && npm run test:e2e
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const EXT = fileURLToPath(new URL('../../', import.meta.url));
const profile = mkdtempSync(join(tmpdir(), 'tab-sweeper-profile-'));
const step = (name) => console.log(`\n▶ ${name}`);
const ok = (msg) => console.log(`  ✔ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Page ${req.url}</title>${req.url}`);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    pipe: true,
    userDataDir: profile,
    enableExtensions: [EXT],
    args: extraArgs,
    protocolTimeout: 20_000,
  });
}

// Chrome can replace the extension's service worker while it starts up or restores a session,
// and a handle to the old worker hangs instead of failing. So look the worker up fresh for every
// call, with a timeout, and retry.
async function inWorker(browser, fn, ...args) {
  let lastError;
  for (let attempt = 0; attempt < 15; attempt++) {
    // A replaced worker can stay listed next to its successor, so try them all, newest first.
    const targets = browser
      .targets()
      .filter((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'))
      .reverse();
    for (const target of targets) {
      try {
        const worker = await target.worker();
        return await Promise.race([
          worker.evaluate(fn, ...args),
          sleep(3000).then(() => Promise.reject(new Error('worker did not answer'))),
        ]);
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(500);
  }
  throw lastError ?? new Error('extension service worker not found');
}

const tabsIn = (browser) => inWorker(browser, () => chrome.tabs.query({ windowType: 'normal' }));
const keptIds = (browser) => inWorker(browser, async () => (await chrome.storage.session.get({ kept: [] })).kept);

async function waitForLock(browser, url, label) {
  for (let i = 0; i < 40; i++) {
    const tab = (await tabsIn(browser)).find((t) => t.url === url);
    if (tab && (await keptIds(browser)).includes(tab.id)) return tab;
    await sleep(250);
  }
  throw new Error(`${label}: ${url} was not re-locked`);
}

let browser;
try {
  step('lock a tab, then quit Chrome');
  browser = await launch();
  for (const path of ['/a', '/b', '/c']) {
    const page = await browser.newPage();
    await page.goto(base + path);
  }
  const before = (await tabsIn(browser)).find((t) => t.url === `${base}/b`);
  assert.equal(await inWorker(browser, (id) => tabSweeper.handlers.toggleKeep({ tabId: id }), before.id), true);
  const { keptSnapshot } = await inWorker(browser, () => chrome.storage.local.get('keptSnapshot'));
  assert.deepEqual(keptSnapshot.map((e) => e.url), [`${base}/b`]);
  ok(`locked ${base}/b (tab ${before.id}) and saved it`);
  await browser.close();

  step('relaunch with session restore');
  browser = await launch(['--restore-last-session']);
  const after = await waitForLock(browser, `${base}/b`, 'after restart');
  const restoredUrls = (await tabsIn(browser)).map((t) => t.url);
  for (const path of ['/a', '/c']) assert.ok(restoredUrls.includes(base + path), `${path} restored`);
  const keptNow = await keptIds(browser);
  assert.deepEqual(keptNow, [after.id], 'only the restored /b tab is locked');
  assert.equal(await inWorker(browser, (id) => chrome.action.getBadgeText({ tabId: id }), after.id), '🔒');
  ok(`restored ${base}/b is locked again (tab ${before.id} → ${after.id}), badge shown, other tabs unlocked`);

  step('lock survives a sweep right after restart');
  await inWorker(browser, () => chrome.storage.sync.set({ idleMinutes: 1, minTabsPerWindow: 0, pauseWhenAway: false }));
  await inWorker(browser, 
    () => tabSweeper.withState((s) => { for (const id of Object.keys(s.lastUsed)) s.lastUsed[id] = Date.now() - 60 * 60_000; }),
  );
  await inWorker(browser, () => tabSweeper.tick());
  const survivors = await tabsIn(browser);
  assert.ok(survivors.some((t) => t.id === after.id), 'locked tab kept');
  for (const t of survivors) assert.ok(t.active || t.id === after.id, `${t.url} should have been swept`);
  ok('locked tab kept, idle unlocked tabs swept');

  step('reload the extension');
  await inWorker(browser, () => void setTimeout(() => chrome.runtime.reload(), 50));
  await sleep(2000);
  const reloaded = await waitForLock(browser, `${base}/b`, 'after extension reload');
  assert.equal(reloaded.id, after.id, 'same tab id re-locked');
  ok(`still locked after reload (tab ${reloaded.id})`);

  step('unlocking is saved too');
  await inWorker(browser, (id) => tabSweeper.handlers.toggleKeep({ tabId: id }), reloaded.id);
  const { keptSnapshot: emptied } = await inWorker(browser, () => chrome.storage.local.get('keptSnapshot'));
  assert.equal(emptied.filter((e) => e.url === `${base}/b`).length, 0);
  ok('unlocked tab removed from the saved list');

  await browser.close();
  console.log('\nAll restart checks passed.');
} finally {
  await browser?.close().catch(() => {});
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
