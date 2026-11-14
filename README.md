# Tab Sweeper

A Chrome extension that tracks which tabs you actually use and automatically closes, or puts to sleep, the ones you don't.

It has no dependencies, makes no network requests and collects no data. Everything stays in your browser's extension storage.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (`~/tab-sweeper`).
4. Pin the extension (puzzle-piece menu → pin), so the popup is one click away.

After you edit the code, click the reload icon on the extension's card.

## How it works

- **Idle time** is the time since you last looked at a tab. A tab's countdown starts when you *leave* it, not when you opened it. Every tab gets a fresh clock when you install the extension or restart Chrome, so it never closes a pile of tabs at once.
- **Once a minute**, any tab idle longer than the threshold (default **2 hours**) is swept, stalest first.
- **Never swept:** the active tab in each window, pinned tabs, tabs playing audio, tabs you've locked in the popup, and sites on your allow-list. Tabs in tab groups can be added to this list in settings.
- **Minimum tabs:** a window is never swept below 3 tabs (configurable).
- **Time away doesn't count.** While your computer is idle for 5+ minutes, locked or asleep, tabs don't age, so you won't come back in the morning to an empty window.
- **Close or sleep:** *close* removes the tab and adds it to *Recently closed* in the popup, where one click reopens it. *Sleep* (`chrome.tabs.discard`) leaves the tab in the strip but frees its memory.

## The popup

- Every open tab, with how long it's been idle and when it will be swept. You can sort by least recent, most recent or tab order, and search titles and URLs (Enter jumps to the first match).
- 🔒 **Keep**: protect one tab from auto-sweep. Unlocking it restarts its clock. A locked tab shows a 🔒 badge on the toolbar icon while it's the current tab. Locks survive restarting Chrome or reloading the extension (see below).
- **Sweep idle tabs** runs the rules now, even when auto-sweep is off.
- **Close duplicates** keeps one copy of each URL, ignoring `#fragments`. It prefers the active, pinned, locked or most recently used copy.
- **Recently closed**: click a row to reopen and switch to the tab, or use ↺ to reopen it in the background.
- The **Auto** switch turns auto-sweep on and off. The sliders icon opens the settings.

## Keyboard shortcut

Press **⌥⇧K** (Option+Shift+K; Alt+Shift+K on Windows and Linux) to lock the current tab, and press it again to unlock it. The 🔒 badge on the toolbar icon confirms it.

To change it, go to `chrome://extensions/shortcuts`, or click **Change shortcut** in settings. Chrome assigns a default shortcut only when it doesn't clash with another extension's. If pressing it does nothing, set it on that page.

### Locks across restarts

Chrome gives every tab a new ID when it restarts, so locks are saved as each tab's URL plus its window and position. When Chrome restores your tabs, each saved lock goes to the restored tab with the same URL. If several tabs share that URL, the one in the same window and nearest the same position wins. Tabs can take a moment to come back, so unmatched locks wait up to 10 minutes for their tab and are then dropped.

Two side effects:
- A lock only comes back if Chrome restores the tab ("Continue where you left off", or reopening the window).
- Within those 10 minutes, a new tab you open on the exact URL of a lock that hasn't been matched yet will be locked instead.

## Settings

Right-click the toolbar icon → **Options**, or use the sliders icon in the popup. Changes save automatically.

Allow-list entries are domains or domain plus path, one per line:

```
mail.google.com        # this host and its subdomains
google.com             # all of *.google.com
github.com/my-org      # only pages under /my-org
```

## Caveats

- Closing a tab loses anything typed into it but not saved, such as a half-written form. Allow-list sites where that matters, or use **Sleep** mode instead. Chrome's sleep mode also reloads the page.
- It only manages normal browser windows. Incognito windows are excluded unless you allow the extension in Incognito on `chrome://extensions`.
- Requires Chrome 120 or later.

## Development

```
src/policy.js      pure decision logic (idle, protections, min-tabs, duplicates, away time)
src/background.js  service worker: usage tracking, the 1-minute alarm, sweeping, popup API
src/popup.*        toolbar popup
src/options.*      settings page
src/format.js      duration/host formatting
scripts/make-icons.mjs  renders icons/*.png (no dependencies)
```

```sh
npm test            # unit tests (Node 22+, no install needed)
npm install && npm run test:e2e   # loads the extension in Chrome for Testing and exercises it
npm run package     # tab-sweeper.zip for the Chrome Web Store
```

The service worker exposes `tabSweeper` for debugging. Open `chrome://extensions` → Tab Sweeper → *service worker*, then try `await tabSweeper.tick()` or `await tabSweeper.handlers.overview()`.
