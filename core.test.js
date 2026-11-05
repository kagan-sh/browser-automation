import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BrowserError,
  IDLE_TTL_MS,
  panelAction,
  SESSION_TTL_MS,
  assertOwner,
  clipText,
  errorBody,
  expireRecord,
  filePath,
  hostCommand,
  imageFailure,
  jpegSize,
  liveness,
} from "./core.js";
import {
  COMMANDS,
  boundedTimeout,
  humanOutput,
  parseCommand,
  parseDuration,
  resolveThread,
  scriptOf,
  timeoutOf,
} from "./cli.js";

/** @param {number} now */
function record(now = Date.now()) {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    threadId: "thread-1",
    state: /** @type {const} */ ("ready"),
    headless: true,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastUsed: now,
  };
}

test("every declared command parses its own usage", () => {
  assert.deepEqual(parseCommand(["prepare"]), { command: "prepare", flags: {}, positionals: [] });
  assert.deepEqual(parseCommand(["open", "--headed", "--json"]), {
    command: "open",
    flags: { "--headed": true, "--json": true },
    positionals: [],
  });
  const run = parseCommand(["run", "abc", "--script", "1+1", "--timeout", "90s"]);
  assert.equal(run.positionals[0], "abc");
  assert.equal(run.flags["--script"], "1+1");
  assert.equal(run.flags["--timeout"], "90s");
  assert.equal(parseCommand(["screenshot", "abc", "--page", "work"]).flags["--page"], "work");
  for (const command of Object.keys(COMMANDS)) {
    const positionals = COMMANDS[command].positionals > 0 ? ["abc"] : [];
    assert.doesNotThrow(() => parseCommand([command, ...positionals]), command);
  }
});

test("help is a flag, not a script value", () => {
  assert.equal(parseCommand(["run", "abc", "--help"]).flags["--help"], true);
  assert.equal(parseCommand(["run", "abc", "-h"]).flags["-h"], true);
  assert.equal(parseCommand(["run", "abc", "--script", "--help"]).flags["--script"], "--help");
  assert.equal(parseCommand(["run", "abc", "--script", "-h"]).flags["--script"], "-h");
});

test("an option may carry its value after =", () => {
  const parsed = parseCommand(["run", "abc", "--script=await 1"]);
  assert.equal(parsed.flags["--script"], "await 1");
  assert.throws(() => parseCommand(["open", "--json=yes"]), /takes no value/);
});

test("bad commands and options are refused with a usage hint", () => {
  assert.throws(() => parseCommand([]), /missing command/);
  assert.throws(() => parseCommand(["browse"]), /unknown command 'browse'/);
  assert.throws(() => parseCommand(["list", "--headless"]), /unknown option '--headless'/);
  assert.throws(() => parseCommand(["list", "--json", "--json"]), /more than once/);
  assert.throws(() => parseCommand(["list", "--thread"]), /missing value for '--thread'/);
  assert.throws(() => parseCommand(["open", "extra"]), /unexpected argument 'extra'/);
  assert.throws(() => parseCommand(["run"]), /missing session id/);
  assert.throws(() => parseCommand(["run", "a", "b"]), /unexpected argument 'b'/);
});

test("a session command needs a thread, and a thread call cannot borrow another", () => {
  assert.equal(resolveThread(undefined, "thread-1"), "thread-1");
  assert.equal(resolveThread("thread-2", undefined), "thread-2");
  assert.equal(resolveThread("thread-1", "thread-1"), "thread-1");
  assert.throws(() => resolveThread(undefined, undefined), /run from a thread or pass --thread/);
  assert.throws(() => resolveThread("thread-2", "thread-1"), /another thread/);
});

test("a timeout reads as seconds, minutes or milliseconds", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("2m"), 120_000);
  assert.equal(parseDuration("1500ms"), 1_500);
  assert.equal(parseDuration("90"), 90_000);
  assert.equal(parseDuration("1500"), 1_500);
  assert.throws(() => parseDuration("soon"), /invalid duration/);
  assert.throws(() => parseDuration("-1"), /invalid duration/);
});

test("timeouts stay inside the run boundary", () => {
  assert.equal(timeoutOf({}), 30_000);
  assert.equal(timeoutOf({ "--timeout-ms": "1000" }), 1_000);
  assert.equal(timeoutOf({ "--timeout": "2m" }), 120_000);
  assert.throws(() => timeoutOf({ "--timeout-ms": "1" }), /between 1000 and 120000/);
  assert.throws(() => timeoutOf({ "--timeout-ms": "120001" }), /between 1000 and 120000/);
  assert.throws(() => timeoutOf({ "--timeout-ms": "1.5" }), /between 1000 and 120000/);
  assert.throws(() => timeoutOf({ "--timeout": "2m", "--timeout-ms": "1000" }), /not both/);
  assert.throws(() => boundedTimeout(Number.NaN), /between 1000 and 120000/);
});

test("run takes exactly one script source", () => {
  assert.deepEqual(scriptOf({ "--script": "1+1" }), { script: "1+1", scriptFile: undefined });
  assert.deepEqual(scriptOf({ "--script-file": "check.js" }), {
    script: undefined,
    scriptFile: "check.js",
  });
  assert.throws(() => scriptOf({}), /exactly one/);
  assert.throws(() => scriptOf({ "--script": "1", "--script-file": "a.js" }), /exactly one/);
  assert.throws(() => scriptOf({ "--script": "   " }), /empty/);
  assert.throws(() => scriptOf({ "--script": "x".repeat(128_001) }), /longer than/);
});

test("a session lives 30 minutes and stops after 5 quiet ones", () => {
  const now = Date.now();
  const fresh = record(now);
  assert.equal(liveness(fresh, now), "ok");
  assert.equal(liveness(fresh, now + SESSION_TTL_MS), "expired");
  assert.equal(liveness({ ...fresh, lastUsed: now - IDLE_TTL_MS }, now), "idle");
  assert.equal(liveness({ ...fresh, lastUsed: now - IDLE_TTL_MS + 1 }, now), "ok");
  assert.equal(liveness({ ...fresh, state: "stopped" }, now), "stopped");
  assert.equal(liveness({ ...fresh, state: "closed" }, now), "closed");
});

test("expiring a record marks why it stopped, once", () => {
  const now = Date.now();
  const expired = record(now);
  expired.expiresAt = now - 1;
  assert.equal(expireRecord(expired, now), true);
  assert.equal(expired.state, "stopped");
  assert.equal(expired.reason, "expired");
  assert.equal(expireRecord(expired, now), false);

  const idle = record(now);
  idle.lastUsed = now - IDLE_TTL_MS;
  assert.equal(expireRecord(idle, now), true);
  assert.equal(idle.reason, "idle");

  const live = record(now);
  assert.equal(expireRecord(live, now), false);
  assert.equal(live.state, "ready");
});

test("a session belongs to the thread that opened it", () => {
  assert.doesNotThrow(() => assertOwner(record(), "thread-1"));
  assert.throws(
    () => assertOwner(record(), "thread-2"),
    (error) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, "session_forbidden");
      return true;
    },
  );
});

test("text and captures stay inside their budgets", () => {
  assert.equal(clipText("hello"), "hello");
  assert.equal(clipText("x".repeat(160_001)).length, 160_000);
  assert.equal(imageFailure([{ bytes: 10 }]), null);
  assert.match(imageFailure(new Array(5).fill({ bytes: 1 })), /at most 4 screenshots/);
  assert.match(imageFailure([{ bytes: 600 * 1024 }]), /bytes; a run may keep/);
});

test("a JPEG's size comes from its frame header", () => {
  const header = [
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00,
    0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ];
  assert.deepEqual(jpegSize(Uint8Array.from(header)), { width: 2, height: 3 });
  assert.equal(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test("a module URL becomes the path the host runs", () => {
  assert.equal(filePath("file:///Users/me/My%20Plugins/main.js"), "/Users/me/My Plugins/main.js");
  assert.equal(filePath("file:///C:/Users/me/main.js"), "C:/Users/me/main.js");
});

test("errors carry a code and a next step", () => {
  assert.deepEqual(errorBody(new BrowserError("nope", "thread_required")), {
    ok: false,
    error: { code: "thread_required", message: "nope" },
  });
  assert.equal(errorBody(new Error("session x does not belong to this thread")).error.code, "session_forbidden");
  assert.equal(errorBody(new Error("session x is stopped; open a new session")).error.code, "session_unavailable");
  const unavailable = errorBody(new Error("session x is stopped; open a new session"));
  assert.match(unavailable.error.hint, /kg browser-automation open/);
  assert.equal(errorBody(new Error("screenshots come to 900000 bytes")).error.code, "screenshot_limit");
  assert.equal(errorBody(new Error("Chrome or Chromium was not found")).error.code, "setup_failed");
  assert.equal(errorBody(new Error("boom")).error.code, "command_failed");
});

test("the bridge builds one quoted bash line", () => {
  const line = hostCommand(
    "export PATH=x; ",
    "/p host/host.mjs",
    "run",
    ["--thread", "t'1", "--script", "a b"],
    "/data dirs",
    "/chrome path",
  );
  assert.equal(
    line,
    `export PATH=x; node '/p host/host.mjs' run '--thread' 't'"'"'1' '--script' 'a b' --data '/data dirs' --chrome '/chrome path'`,
  );
  assert.equal(
    hostCommand("", "/h.mjs", "list", ["--thread", "t"], "/d"),
    "node '/h.mjs' list '--thread' 't' --data '/d'",
  );
});

test("the panel protocol maps each message to one action", () => {
  assert.deepEqual(panelAction({ type: "state" }), { kind: "state" });
  assert.deepEqual(panelAction({ type: "refresh" }), { kind: "state" });
  assert.deepEqual(panelAction({ type: "open" }), { kind: "open" });
  assert.deepEqual(panelAction({ type: "stop", id: "s" }), { kind: "stop", id: "s" });
  assert.deepEqual(panelAction({ type: "close", id: "s" }), { kind: "close", id: "s" });
  assert.deepEqual(panelAction({ type: "frame", id: "s", request: 7 }), {
    kind: "frame",
    id: "s",
    request: 7,
  });
  assert.deepEqual(panelAction({ type: "click", id: "s", x: 3, y: 4 }), {
    kind: "input",
    id: "s",
    input: { kind: "click", x: 3, y: 4, delta: 0, text: "", key: "Enter" },
  });
  assert.deepEqual(panelAction({ type: "type", id: "s", text: "hi" }).input, {
    kind: "type",
    x: 0,
    y: 0,
    delta: 0,
    text: "hi",
    key: "Enter",
  });
  assert.equal(panelAction({ type: "wheel", id: "s", delta: -40 }).input.delta, -40);
  assert.deepEqual(panelAction({ type: "nonsense" }), { kind: "none" });
  assert.deepEqual(panelAction(null), { kind: "none" });
  assert.deepEqual(panelAction("state"), { kind: "none" });
});

test("the human output says what happened without JSON", () => {
  assert.match(humanOutput("open", { id: "abc", headless: true }), /Session abc open \(headless Chrome\)/);
  assert.equal(humanOutput("list", []), "No sessions for this thread.");
  assert.match(humanOutput("list", [{ state: "ready", id: "abc", url: "https://example.com", expiresAt: Date.now() + 1000 }]), /ready/);
  assert.equal(humanOutput("preview", { frame: null }), "No new frame.");
  assert.match(humanOutput("preview", { frame: { sequence: 3, width: 2, height: 1, url: "u", title: "t" } }), /Frame 3 2x1 u t/);
  assert.match(humanOutput("screenshot", { text: "/tmp/a.jpg", images: [{ path: "/tmp/a.jpg" }] }), /Screenshot saved to \/tmp\/a\.jpg/);
  assert.equal(humanOutput("run", { text: "ok", images: [] }), "ok");
  assert.match(humanOutput("run", { text: "", images: [{ path: "/tmp/a.jpg", width: 2, height: 3 }] }), /\(ok\)\nimage: \/tmp\/a\.jpg \(2x3\)/);
});
