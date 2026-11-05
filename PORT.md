# Port record: BB browser-automation → kagan

Reference: `/Users/aorumbayev/projects/bb/plugins/browser-automation`
(its tests are the authority on behaviour). This file is re-checked against the
code, not the other way round.

## Same

- CLI surface: `open` / `list` / `run` / `pages` / `screenshot` / `preview` /
  `stop` / `close`, plus `prepare`, with `--json`, `--help`, `--thread` and
  `--script-file`.
- Agent tools for the same actions: `browser_open`, `browser_run`,
  `browser_screenshot`, `browser_pages`, `browser_list`, `browser_stop`,
  `browser_close`.
- Thread-owned sessions: an id from another thread is refused
  (`does not belong to this thread`), `list` shows only this thread's sessions.
- Session lifetime: 30 minutes absolute, 5 minutes idle, 64 sessions per
  thread. Runs serialize per session; timeout stops the session; `stop` keeps
  the record, `close` removes the profile; archiving the thread closes sessions.
- Run limits: 128000-character script, 160000-character text result, at most 4
  JPEG captures and 500 KB together; screenshots return
  `{ path, mimeType, width, height }`.
- CLI errors: non-zero exit, and with `--json` a
  `{"ok":false,"error":{code,message,hint}}` object for
  `session_unavailable`, `session_forbidden`, `screenshot_limit`,
  `setup_failed`, `invalid_option`, `thread_required`, `cross_thread`.
- Named pages: `getPage("main")`, named tabs that survive between runs,
  `pages` / `listPages`.
- First-run install of the browser runtime inside the plugin's data folder,
  from an exact pin (`playwright-core@1.63.0`), with no global install.
- A skill that teaches open → script → screenshot → close.
- A right-sidebar surface listing the thread's sessions.
- A screenshot of the page, sized in the result.

## Differs

- Runtime: `playwright-core` over Chrome's CDP endpoint, pinned in `core.js`.
  BB pins the `dev-browser` release, verifies SLSA provenance and per-platform
  digests, and never reuses a `PATH` binary. Here the package comes from npm
  with `--ignore-scripts`; the binary is the Chrome the person already has.
- Script API: Playwright helpers (`getPage`, `snapshot`, `click`, `fill`,
  `shot`) instead of the full DevBrowser API (network interception, tracing,
  PDF, upload). `snapshot()` is Playwright's ARIA snapshot with refs; refs
  follow document order, so a fresh snapshot in the same run is the reliable
  way to click one.
- The browser surface is a right-panel **web page** (decision 133): it paints
  the live frame and carries a click, wheel or keystroke back into the page.
  It is a view of Chrome, not a browser of its own; BB's desktop tab is the
  browser itself.
- One Chrome on one persistent profile; a session is a tab. BB's local sessions
  get a fresh `DEV_BROWSER_HOME` per session, which loses logins on close; its
  desktop and in-app browsers are the ones that keep them. Here `close` keeps
  the profile, and Chrome stays up ten minutes after the last close so even a
  session-only cookie survives a quick reopen.
- `preview` captures one frame per call instead of long-polling a screencast.
  There is no `--after` cursor, because nothing streams between calls.
- A hung script is killed by running the script in its own node process
  (`runner.mjs`) and stopping the session; BB's host does the same in Rust.
- The headless window is 1280×800; captures are one viewport, not `maxEdge`
  scaled.
- Settings: `chromePath` (BB exposes no settings of its own; its runtime and
  host are implicit).
- The runtime pin lives in `core.js`; `package.json` declares no dependency,
  because nothing in the repo imports playwright-core (it is installed into the
  plugin data folder at first use).
- Chrome launches with `--no-sandbox`, as BB's plugin-owned Chrome does.
- No `--backend` / `--machine` / `--desktop` / `--tab` / `--new-tab`: there is
  one machine and one backend.

## Cannot move (re-verified against the current plugin API)

- **Kagan's built-in Browser tab.** It is a host-owned `gpui-webview` page
  (decision 117, amended by 131). `docs/plugin-api.md` states plugins cannot use
  it; `crates/plugins/src` has no host function that opens or reads it, and
  `kg` has no `browser` command (decision 31). It would need a host API that
  exposes navigation, evaluation and input to a plugin. The plugin's own panel
  is the substitute.
- **Desktop attach / "take over" input.** Same host gap: a plugin can draw and
  show `WebView` pages but cannot send input to, or read the DOM of, a page it
  did not serve itself.
- **Inline chat live preview and lightbox.** kagan has no message directives;
  `kagan/panel.post` reaches a plugin's own panel page only. The panel preview
  is the substitute.
- **Remote / enrolled hosts and `--machine`.** kagan is single-machine: no hosts
  area, no host ids, no `bb file read --host`. Would need a host transport in
  the plugin API.
- **Cloud CDP endpoints.** Excluded in BB too. Here `powers.fetch` only reaches
  declared hosts and never a web socket, so an arbitrary `wss://` CDP endpoint
  cannot be reached at all.
- **`--script-host` and cross-host file transfer.** Not needed with one machine;
  `--script-file` reads the invoking working directory directly.

## Powers asked

- `areas: ["process"]` and `run: [{ "program": "bash", "env": "inherit" }]`, so
  `node`, `npm` and Chrome are found through a login-shell PATH.
- No `fetch`, no file roots beyond the plugin folder and its data folder, no
  clipboard.

## Checks

- `kg plugin check .` → passed (manifest, web panel file, schemas).
- `node --test` → logic and host tests without a browser.
- `KG_E2E=1 node --test e2e.test.js` → real Chrome: browse, snapshot, click,
  fill, capture, preview, serialization, timeout, named pages, close.
