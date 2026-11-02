---
name: browser-automation
description: Control a local Chrome session from this thread — open pages, snapshot, click, fill forms, and take screenshots. Use for UI checks and web flows inside kagan.
---

Use `kg browser-automation` (or the `browser_*` tools). Open one session, keep its id, then act in short scripts.

This port runs **local Chrome only** on the machine where kagan runs. There is no remote host list and no attachment to kagan's sidebar Browser tab (that tab is view-only). Prefer headless unless the person asked to watch a window (`--headed` / `headed: true`).

## Open

```sh
kg browser-automation open --json
kg browser-automation open --headed --json
```

Tools: `browser_open`. Retain the returned `id`.

## Run scripts

```sh
kg browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); return await p.snapshot()' --json
kg browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.click("text=Sign in"); return await p.snapshot()' --json
```

The script receives `browser` with:

- `getPage("main")` → page helpers: `goto`, `snapshot`, `click`, `fill`, `type`, `press`, `title`, `url`, `content`, `evaluate`, `waitForSelector`, `shot`, `locator`, `raw` (Playwright page)
- `pages()` → `[{ id, url, title }]`

`snapshot()` prefers Playwright's AI snapshot (refs like `e12`). After navigation, take a fresh snapshot before clicking refs. `click("e12")` or `click("ref/e12")` uses `aria-ref`; any other string is a Playwright locator (for example `text=Submit` or `#email`).

`shot()` writes a JPEG under the session folder and returns `{ path, mimeType }`. Prefer a text/snapshot check after each step; screenshot when visual proof matters.

## Other commands

```sh
kg browser-automation list --json
kg browser-automation pages <session-id> --json
kg browser-automation screenshot <session-id> --json
kg browser-automation stop <session-id> --json
kg browser-automation close <session-id> --json
```

`stop` kills Chrome but keeps the session record. `close` kills Chrome and clears the profile. Sessions expire after 30 minutes of wall time; reopen if Chrome is gone.

First open installs `playwright-core` into the plugin data folder (needs `npm` on PATH). Chrome/Chromium must already be installed.
