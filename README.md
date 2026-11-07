# Browser Automation for kagan

Drive the built-in **Browser** tab. The plus menu has one Browser, and this
plugin is how an agent opens and drives that tab. It does not add a panel.

One http or https page per window, owned by one thread. A bare name such as
`example.com` loads over https. A local host such as `localhost:3000` loads
over http. Logins end when the page closes. The page cannot use the camera or
microphone. On Linux the host refuses every call with "The browser works on
macOS and Windows only for now."

## Install

```sh
kg plugin install git:https://github.com/kagan-sh/browser-automation@main
```

Approve **opens and drives the Browser tab for a thread it names**. The app
has to include that area (`kagan/browser`, decision 161). Nothing is installed
on first open: there is no Chrome binary and no npm package.

## Try

```sh
kg browser-automation open https://example.com --json
kg browser-automation snapshot --json
kg browser-automation click 2 --json
kg browser-automation fill 3 ada@example.com --json
kg browser-automation close --json
```

Without `--json` each command prints one plain sentence, or the snapshot.
`--help` on a command lists its flags. `kg browser` is the same page with the
same verbs; this plugin is the tool surface an agent calls.

## Commands

| Command | What it does |
| --- | --- |
| `open <url>` | Open the Browser tab and load the address |
| `status` | Read the url, title, and whether the tab is showing |
| `snapshot` | Read controls (whole-number refs) and the page text |
| `goto <url>` | Load another address. Old refs are gone |
| `back` / `forward` / `reload` | Move through the page |
| `click <ref>` | Click a ref from the latest snapshot |
| `fill <ref> <text>` | Write text into a control. The words are the text, not a file |
| `type <text>` | Type into the focused control |
| `press <key>` | Press a key in the focused control |
| `select <ref> <option>` | Choose a select option by value or label |
| `scroll <dy>` | Scroll by dy pixels. Positive is down |
| `close` | Stop driving. The page stays open |

A call from a thread uses that thread. Outside one, pass `--thread <id>`. A
call from a thread cannot name another thread. Another thread already driving
the page is refused, and the message names the owner. After 30 minutes with no
command, the next command ends driving and leaves the page as the person's.

`click`, `fill`, and `select` take a ref from the latest snapshot. A ref is a
whole number. A fraction, a word, or a CSS selector is refused. `press` takes
`enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`,
`right`, `home`, `end`, `pageup`, `pagedown`, or one character.

With `--json`, a failure prints `{"ok":false,"error":{code,message,hint}}` and
exits non-zero.

## Limits

The host tab is one http or https page. A ref is a whole number from the latest
snapshot. Fill writes the text in the call. There is no script evaluation, no
CDP, no arbitrary selector, no screenshot, and no second page. The old panel,
Playwright, and file fill were removed because the host cannot do them.
