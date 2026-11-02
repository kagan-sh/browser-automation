# Browser Automation for kagan

Local Chrome sessions for agents: open a page, snapshot, click, fill forms, and take screenshots.

Ported from BB’s browser-automation for **this machine only**. It does not drive kagan’s sidebar Browser tab and does not talk to remote hosts.

## Install

```sh
kg plugin install git:https://github.com/kagan-sh/browser-automation@main
```

Approve **runs bash with your environment** when asked. Needs Google Chrome or Chromium, plus `node`/`npm` reachable from a login shell (Homebrew or nvm).

## Try

```sh
kg browser-automation open --json
kg browser-automation run <id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); return await p.title()' --json
kg browser-automation close <id> --json
```

Or use the `browser_*` tools / the bundled skill. A **Browser** tab in the right sidebar lists this thread’s sessions.

## Gaps vs BB

- No remote/enrolled hosts
- No attach to the in-app Browser tab
- No inline chat live preview
- Scripts use Playwright helpers, not DevBrowser
