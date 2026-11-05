---
name: browser-automation
description: Control a local headless Chrome session from this thread — open pages, snapshot, click, fill forms, and take screenshots. The Browser tab in the right sidebar shows the session live. Use for UI checks and web flows inside kagan.
---

Use `kg browser-automation` (or the `browser_*` tools). Open one session, keep
its id, then act in short scripts. The right-sidebar **Browser** tab follows the
thread and shows the page, so the person can watch and click along; you and the
person drive the same page.

This plugin runs **local headless Chrome** on the machine where kagan runs. It
cannot drive kagan's built-in Browser tab (the host keeps it; decision 117), and
there is no remote host list. Prefer headless unless the person asked to watch a
real window (`--headed` / `headed: true`).

## Open

```sh
kg browser-automation open --json
kg browser-automation open --headed --json
```

Tools: `browser_open`. Retain the returned `id`. The first open installs
`playwright-core` into the plugin data folder (needs npm), then opens Chrome.

## Run scripts

```sh
kg browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); return await p.title()' --json
kg browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.click("text=Sign in"); return await p.snapshot()' --json
kg browser-automation run <session-id> --script-file ./check.js --json
```

The script receives `browser`:

- `await browser.getPage("main")` → page helpers. Any other name is a named tab
  that persists between runs.
- `browser.listPages()` → `[{ name, url, title }]`
- Page helpers: `goto`, `snapshot`, `click`, `fill`, `type`, `press`, `title`,
  `url`, `content`, `evaluate`, `waitForSelector`, `shot`, `locator`, `raw`
  (the Playwright page).

`snapshot()` returns Playwright's AI ARIA snapshot with refs like `e12`.
`click("e12")` or `click("ref/e12")` uses a ref; any other string is a
Playwright locator (`#email`, `text=Submit`). Take a snapshot in the same run
before clicking a ref, and a fresh one after navigation: refs follow document
order.

`shot()` writes a JPEG under the session folder and returns `{ path, mimeType }`.
A run may keep at most 4 JPEGs, 500 KB together; anything larger fails the run.
Prefer a cheap snapshot or URL check after each step and a screenshot when
visual proof matters.

## Other commands

```sh
kg browser-automation list --json
kg browser-automation pages <session-id> --json
kg browser-automation screenshot <session-id> [--page main] --json
kg browser-automation preview <session-id> --json
kg browser-automation stop <session-id> --json
kg browser-automation close <session-id> --json
```

`stop` closes the session's tab and keeps its record; `close` also removes its
captures. Neither clears the profile: logins, cookies and `localStorage` survive
a close and come back on the next open, because every session is a tab in one
Chrome. Sessions belong to the thread that opened them and expire after 30
minutes, or after 5 idle minutes; `run`, `pages` and `screenshot` count as use.
Runs in one session are serialized, and a script past its timeout
(`--timeout-ms 30000`, or `--timeout 90s`) stops the session. Reopen when the
tab is gone.

Every command takes `--json` for machine output and `--help` for its flags.
With `--json`, a failure prints `{"ok":false,"error":{code,message,hint}}` on
stdout and exits non-zero; `session_unavailable` means reopen, and
`screenshot_limit` means the capture budget was passed.
