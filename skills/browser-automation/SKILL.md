---
name: browser-automation
description: Drive kagan's built-in Browser tab for this thread — open one http or https page, read a snapshot, and click, fill, type, press, select, or scroll using whole-number refs.
---

Use the `browser_*` tools, or `kg browser-automation`. This drives the built-in
Browser tab for the thread you are in. There is one page per window. The person
sees that same tab. You do not get a second Browser.

## Open

```sh
kg browser-automation open https://example.com --json
```

Tool: `browser_open` with `{ "url": "https://example.com" }`. http and https
open. A bare name such as `example.com` loads over https. A local host such as
`localhost:3000` loads over http. Anything else is refused by the host.

Another thread already driving the page is refused, and the message names that
thread. `browser_close` or `kg browser close` stops driving and leaves the page
open for the person.

## Read

```sh
kg browser-automation snapshot --json
kg browser-automation status --json
```

Tools: `browser_snapshot`, `browser_status`.

A snapshot lists each control as `[ref] role "name"`. `ref` is a whole number.
Use it with click, fill, and select. Take a fresh snapshot after a navigation
or another snapshot: the old refs are gone. `truncated` means the host cut the
snapshot. There is no screenshot and no script you can run against the page.

## Act

```sh
kg browser-automation click 2 --json
kg browser-automation fill 3 ada@example.com --json
kg browser-automation type hello --json
kg browser-automation press enter --json
kg browser-automation select 4 Blue --json
kg browser-automation scroll 200 --json
kg browser-automation goto https://example.org --json
kg browser-automation back --json
kg browser-automation forward --json
kg browser-automation reload --json
```

Tools: `browser_click`, `browser_fill`, `browser_type`, `browser_press`,
`browser_select`, `browser_scroll`, `browser_goto`, `browser_back`,
`browser_forward`, `browser_reload`.

`fill` writes the text you pass. It does not read a file. A ref that is not a
whole number is refused before the call. `press` takes `enter`, `escape`,
`tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`,
`end`, `pageup`, `pagedown`, or one character.

## Close

```sh
kg browser-automation close --json
```

Tool: `browser_close`. Driving stops. The page stays open, with its address in
the field. The host ends a quiet page after 30 minutes on the next command.

Every command takes `--json` and `--help`. Outside a thread, pass `--thread`.
A call from a thread cannot name another thread. On Linux the host answers
`The browser works on macOS and Windows only for now.`
