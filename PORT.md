# Port record: BB browser-automation → kagan

Reference: `/Users/aorumbayev/projects/bb/plugins/browser-automation`.
Host contract: kagan commit `f94b4f84` (PR 79, decision 161) and
`docs/plugin-api.md` section `browser`. This file is re-checked against the
code.

BB drives the app's own browser through `experimental_desktopBrowsers` and does
not register a second panel named Browser. This plugin does the same job
through `kagan/browser`: the plus menu's one Browser tab.

## Same

- An agent can open a page, read it, click, fill, type, press, select, scroll,
  go back, forward, reload, and close.
- The page is the app's own browser. One page per window, owned by one thread.
  Another thread is refused, and the message names the owner.
- Fill writes text into a control.
- A skill teaches open, then a snapshot, then actions, then close.
- CLI flags `--json`, `--help`, and `--thread`.

## Differs

- The call is `kagan/browser`, granted by `powers.areas: ["browser"]`. BB calls
  `experimental_desktopBrowsers`.
- There is no session id. The thread id is how a call names the page.
- `close` stops driving and leaves the page open for the person. There is no
  plugin profile to delete.
- A ref is a whole number from the host snapshot, not an `e12` token and not a
  selector.
- The idle limit is the host's 30 minutes. This plugin does not time the page.
- `kg browser` is the same verbs on the same page. The plugin is the tool and
  `kg browser-automation` surface.

## Removed, because the host cannot do them

Decision 161 and `kagan/browser`: no `evaluate`, no CDP, no arbitrary selector,
no second page, and fill has no file argument. A plugin does not declare a
panel to stand in for the Browser tab. The test window cannot host a native
page, so nothing here opens one.

- The right panel titled Browser (`ui.panels`, id `sessions`), its page, and
  the live frame. Clicks, scrolling, and keystrokes in that frame are gone.
  The built-in tab is the surface.
- Playwright, the headless Chrome profile, `playwright-core` installed into
  the plugin data folder, `chromePath`, and the `prepare` command.
- `browser_run` and script evaluation (`evaluate`, locators, a raw page).
- Screenshots, JPEG budgets, and `preview` frames.
- Named pages and more than one page. One http or https page per window.
- Filling from a file (`--file`). The text in the call is what is written.
- The plugin's own session list, 5-minute idle timer, 30-minute absolute
  timer, and close-on-archive. The host owns the page.

## Still cannot move

- Remote and enrolled machines, and `--machine`. kagan is one machine.
- Inline chat preview and the lightbox. kagan has no message directive for a
  live page.
- A screenshot of the page. The host snapshot is text and controls.
- A general script API, network interception, tracing, PDF, and upload.
- Cloud CDP. This plugin does not fetch.

## Powers asked

- `areas: ["browser"]` only. The install card says "opens and drives the
  Browser tab for a thread it names".
- No `process`, no bash, no `threads` events, no fetch, no settings.

## Checks

- `node --test` reads the manifest: no panel, no title, area `browser`, and
  the fourteen host verbs.
- `node --test` runs a tool call through `kagan/browser` with the module
  stubbed. No webview is opened.
