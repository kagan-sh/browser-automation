# Browser Automation for kagan

Let an agent drive a local headless Chrome, and watch it live in kagan's right
sidebar.

One Chrome with one persistent profile serves every session: a session is a tab,
not a browser of its own. So a login, a cookie or a `localStorage` value
survives closing a session, and the next open finds it again. The plugin's
**Browser** tab follows the thread on screen and shows the page the last script
touched.

This is not kagan's built-in **Browser** tab. That tab is host-owned: kagan
refuses plugins any access to it (decision 117, `docs/plugin-api.md` "Not in
this API"), and `kg` has no browser command. The plugin's own panel is the
browser surface.

## Install

```sh
kg plugin install git:https://github.com/kagan-sh/browser-automation@main
```

Approve **runs bash with your environment** when asked. Needs Google Chrome or
Chromium, plus `node` and `npm` reachable from a login shell (Homebrew or nvm).
Set **Chrome executable** in the plugin settings when Chrome lives somewhere
unusual.

The first `open` installs `playwright-core@1.63.0` into
`<kagan data>/plugins/dev.kagan.browser-automation/data/runtime`, with
`--ignore-scripts`. Nothing is installed globally. `kg browser-automation
prepare` does the same install ahead of time.

## Try

```sh
kg browser-automation open --json
kg browser-automation run <id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); return await p.title()' --json
kg browser-automation screenshot <id> --json
kg browser-automation close <id> --json
```

Without `--json` each command prints one plain sentence, or the script's text.
`--help` on the plugin or any command lists the flags.

## Commands

| Command | What it does |
| --- | --- |
| `prepare` | Install the browser runtime if it is missing |
| `open [--headed]` | Open a session for this thread |
| `list` | List this thread's sessions |
| `run <id> --script <js>` / `--script-file <path>` | Run a trusted script |
| `pages <id>` | List the session's pages, names, URLs and titles |
| `screenshot <id> [--page main]` | Save a JPEG and return its path |
| `preview <id>` | Describe the panel's live frame, without image bytes |
| `stop <id>` | Close the tab, keep the record; logins stay |
| `close <id>` | Close the tab and remove its captures; logins stay |

Every session command takes `--thread <id>` outside a thread. A call from inside
a thread cannot name another thread's session.

## Script API

The script runs with a `browser` object:

- `await browser.getPage(name)` → page helpers. `"main"` is the first tab; any
  other name is a named tab that persists between runs.
- `browser.listPages()` / `browser.pages()` → `[{ name, url, title }]`.
- Page helpers: `goto`, `snapshot`, `click`, `fill`, `type`, `press`, `title`,
  `url`, `content`, `evaluate`, `waitForSelector`, `shot`, `locator`, `raw`.

`snapshot()` returns Playwright's AI ARIA snapshot with refs such as `e12`.
`click("e12")` and `click("ref/e12")` use those refs; anything else is a
Playwright locator (`text=Sign in`, `#email`). Take a fresh snapshot in the same
run before clicking a ref: a later run re-takes one, but refs follow document
order, so they can move after a change.

`shot()` writes `shot-N.jpg` in the session folder and returns
`{ path, mimeType }`. A run may keep at most 4 JPEGs, 500 KB together; a larger
or non-JPEG capture fails the run.

## Session lifetime

- A session expires 30 minutes after it opens, and is stopped after 5 quiet
  minutes. `run`, `pages` and `screenshot` count as activity; watching the live
  panel does not.
- `stop` closes the session's tab and keeps the record; `close` also removes its
  captures. Neither touches the profile, so logins remain. Archiving or deleting
  the thread closes its sessions.
- Chrome stays up for ten minutes after the last session ends, so a quick
  reopen keeps even a session-only login; a detached reaper stops it then, and
  the profile at `<kagan data>/plugins/dev.kagan.browser-automation/data/profile`
  keeps persistent logins across restarts. Delete that folder to forget them.
- `--headed` asks for a window. A running browser keeps its mode; with no open
  session the plugin restarts it in the mode you asked for.
- Runs in one session are serialized, and a run that passes its timeout stops
  the session instead of leaving a stuck script behind.
- Sessions in different threads share the one browser and run in parallel
  tabs.
- Timeouts: 1000–120000 ms. `--timeout-ms 30000` or `--timeout 90s` / `2m` /
  `1500ms`; a bare number is seconds when 1–120, otherwise milliseconds.
- Scripts are at most 128000 characters and their text result at most 160000.
- A thread may hold 64 sessions at once.

## The Browser tab

The tab lists this thread's sessions, shows the state, URL and title, and paints
a fresh frame of the page about every 1.5 seconds while it is open. **Open**
starts a session, **Stop** and **Close** end one, **Refresh** re-reads the list.
A click, a scroll or a keystroke in the frame is carried into the page at the
same place, so you and the agent drive one browser. A click while a script runs
is refused rather than queued.

## Gaps vs BB

BB's plugin drives its own desktop browser tab and hosted machines, and posts a
live preview into the chat. kagan's plugin API has none of that: no host list,
no chat directives, no web sockets to an arbitrary CDP endpoint. The right
panel here is the equivalent surface. See `PORT.md` for the item-by-item record.
