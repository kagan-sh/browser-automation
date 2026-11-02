```
Plugin: Browser Automation
Source: /Users/aorumbayev/projects/bb/plugins/browser-automation
kagan id: dev.kagan.browser-automation

Moved as-is:
- CLI surface open/list/run/pages/screenshot/stop/close
- Agent tools for the same actions
- Skill teaching open → script → screenshot → close
- Thread-owned sessions with TTL

Close (what differs):
- Local Chrome via Playwright CDP instead of DevBrowser pin/installer
- Script API is Playwright helpers (getPage/goto/snapshot/click/fill/shot), not full DevBrowser
- First open runs `npm install playwright-core` into plugin dataDir
- Right panel lists sessions (BB used chat preview + host UI)

Gaps (workaround, or cannot move):
- Remote/enrolled hosts and bb.host — cannot move
- Desktop attach to in-app Browser tab — cannot move (kagan plugins have no webview; sidebar Browser is host-owned)
- Inline chat live preview / lightbox — cannot move (no message directives)
- Multi-machine --machine selection — cannot move
- Cloud CDP endpoints — excluded in BB too

Powers asked:
- areas: process
- run: node (inherit), npm (inherit)

Right panel: supported
Theme: no theme
kg plugin check: passed
Tried: host.mjs open/run/close against Google Chrome (example.com title OK). Install waits for person approval in Questions.
```
