// A tool call has to reach the host module. The stub stands in for kagan/browser
// so this file never opens a webview — the test window cannot host one.
import { register } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

register("./stub/hooks.mjs", { parentURL: import.meta.url });

test("a tool call reaches kagan/browser", async () => {
  const source = readFileSync(new URL("./browser.js", import.meta.url), "utf8");
  assert.match(source, /from "kagan\/browser"/);

  const browser = await import("kagan/browser");
  const { handle } = await import("./drive.js");
  browser.reset();

  const opened = await handle({
    kind: "tool",
    name: "browser_open",
    threadId: "thr_1",
    input: { url: "https://example.com" },
  });
  assert.equal(opened.isError, undefined);
  assert.match(opened.text, /https:\/\/example\.com/);
  assert.doesNotMatch(opened.text, /playwright|headless|screenshot/i);
  assert.deepEqual(browser.calls, [{ verb: "open", args: ["thr_1", "https://example.com"] }]);

  browser.reset();
  const filled = await handle({
    kind: "tool",
    name: "browser_fill",
    threadId: "thr_1",
    input: { ref: 2, text: "ada@example.com", file: "/tmp/secret.txt" },
  });
  assert.equal(filled.isError, undefined);
  assert.equal(filled.text, "Filled 2.");
  assert.deepEqual(browser.calls, [{ verb: "fill", args: ["thr_1", 2, "ada@example.com"] }]);

  browser.reset();
  const fractional = await handle({
    kind: "tool",
    name: "browser_click",
    threadId: "thr_1",
    input: { ref: 1.5 },
  });
  assert.equal(fractional.isError, true);
  assert.match(fractional.text, /whole number/);
  assert.deepEqual(browser.calls, []);

  browser.reset();
  const clicked = await handle({
    kind: "tool",
    name: "browser_click",
    threadId: "thr_1",
    input: { ref: 4 },
  });
  assert.deepEqual(browser.calls, [{ verb: "click", args: ["thr_1", 4] }]);

  browser.reset();
  const gone = await handle({
    kind: "cli",
    command: "goto",
    argv: ["https://example.org", "--json"],
    threadId: "thr_1",
  });
  assert.equal(gone.exitCode, 0);
  assert.deepEqual(browser.calls, [{ verb: "goto", args: ["thr_1", "https://example.org"] }]);
  assert.equal(JSON.parse(gone.stdout).ok, true);

  browser.reset();
  const file = await handle({
    kind: "cli",
    command: "fill",
    argv: ["2", "--file", "note.txt"],
    threadId: "thr_1",
  });
  assert.equal(file.exitCode, 1);
  assert.match(file.stderr, /unknown option '--file'/);
  assert.deepEqual(browser.calls, []);

  const samples = {
    browser_open: { url: "https://example.com" },
    browser_status: {},
    browser_snapshot: {},
    browser_goto: { url: "https://example.com" },
    browser_back: {},
    browser_forward: {},
    browser_reload: {},
    browser_click: { ref: 1 },
    browser_fill: { ref: 1, text: "ada" },
    browser_type: { text: "a" },
    browser_press: { key: "enter" },
    browser_select: { ref: 1, option: "Blue" },
    browser_scroll: { dy: -20 },
    browser_close: {},
  };
  for (const [name, input] of Object.entries(samples)) {
    browser.reset();
    const result = await handle({ kind: "tool", name, threadId: "thr_1", input });
    assert.equal(result.isError, undefined, `${name}: ${result.text}`);
    assert.equal(browser.calls[0].verb, name.slice("browser_".length), name);
    assert.equal(browser.calls[0].args[0], "thr_1", name);
  }

  browser.reset();
  const hostError = new Error("thread Other is driving the browser; close it with kg browser close");
  browser.failNext(hostError);
  const refused = await handle({
    kind: "tool",
    name: "browser_status",
    threadId: "thr_1",
    input: {},
  });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /driving the browser/);
  assert.deepEqual(browser.calls, [{ verb: "status", args: ["thr_1"] }]);
});
