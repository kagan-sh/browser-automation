// The node host without a browser: session storage, expiry, ownership and the
// argument errors every command shares. Real Chrome lives in e2e.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { IDLE_TTL_MS, SESSION_TTL_MS } from "./core.js";
import { sessionPath, writeSession } from "./store.js";

const run = promisify(execFile);
const HOST = join(dirname(fileURLToPath(import.meta.url)), "host.mjs");

/**
 * @param {string} data
 * @param {string} threadId
 * @param {Record<string, any>} patch
 */
function session(data, threadId, patch = {}) {
  const now = Date.now();
  const id = patch.id ?? "11111111-2222-3333-4444-555555555555";
  const record = {
    id,
    threadId,
    state: "ready",
    headless: true,
    pageId: "PAGE-1",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastUsed: now,
    url: "about:blank",
    title: "",
    ...patch,
  };
  writeSession(data, record);
  return sessionPath(data, threadId, id);
}

/**
 * @param {string} data
 * @param {string[]} argv
 */
async function host(data, argv) {
  try {
    const result = await run(process.execPath, [HOST, ...argv, "--data", data]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = /** @type {{ code?: number, stdout?: string, stderr?: string }} */ (error);
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** @param {string} stderr */
function failure(stderr) {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line);
}

test("list is empty before a thread opens anything", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    const result = await host(data, ["list", "--thread", "thread-1"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("list marks a session that ran out of wall time as stopped", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    const now = Date.now();
    const dir = session(data, "thread-1", { expiresAt: now - 1 });
    const result = await host(data, ["list", "--thread", "thread-1"]);
    assert.equal(result.code, 0);
    const [listed] = JSON.parse(result.stdout);
    assert.equal(listed.state, "stopped");
    assert.equal(listed.reason, "expired");
    const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    assert.equal(saved.reason, "expired");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("an idle session is stopped before its absolute expiry", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    const dir = session(data, "thread-1", { lastUsed: Date.now() - IDLE_TTL_MS });
    const result = await host(data, ["pages", "--thread", "thread-1", "--session", "11111111-2222-3333-4444-555555555555"]);
    assert.equal(result.code, 1);
    assert.equal(failure(result.stderr).error.code, "session_unavailable");
    assert.equal(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).reason, "idle");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("another thread cannot use a session, even with its id", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    session(data, "thread-1");
    const result = await host(data, [
      "pages",
      "--thread",
      "thread-2",
      "--session",
      "11111111-2222-3333-4444-555555555555",
    ]);
    assert.equal(result.code, 1);
    const body = failure(result.stderr);
    assert.equal(body.error.code, "session_unavailable");
    assert.match(body.error.message, /not found/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a record saved under the wrong thread is refused", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    // A record whose folder says one thread and whose body says another: the
    // kind of damage a hand edit or a move causes.
    const id = "11111111-2222-3333-4444-555555555555";
    const at = sessionPath(data, "thread-1", id);
    mkdirSync(at, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(at, "session.json"),
      JSON.stringify({
        id,
        threadId: "thread-2",
        state: "ready",
        headless: true,
        pageId: "PAGE-1",
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        lastUsed: now,
      }),
    );
    const result = await host(data, ["pages", "--thread", "thread-1", "--session", id]);
    assert.equal(result.code, 1);
    assert.equal(failure(result.stderr).error.code, "session_forbidden");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("every session command needs a thread and a session", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    for (const command of ["open", "list", "pages", "screenshot", "preview", "input", "stop", "close"]) {
      const missingThread = await host(data, [command]);
      assert.equal(missingThread.code, 1, command);
      assert.equal(failure(missingThread.stderr).error.code, "invalid_option", command);
    }
    for (const command of ["pages", "screenshot", "preview", "input", "stop", "close"]) {
      const missingSession = await host(data, [command, "--thread", "thread-1"]);
      assert.equal(missingSession.code, 1, command);
      assert.match(failure(missingSession.stderr).error.message, /pass --session/, command);
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("run refuses a missing or doubled script source", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    session(data, "thread-1");
    const id = "11111111-2222-3333-4444-555555555555";
    const missing = await host(data, ["run", "--thread", "thread-1", "--session", id]);
    assert.equal(failure(missing.stderr).error.code, "invalid_option");
    const doubled = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      "1",
      "--script-file",
      "a.js",
    ]);
    assert.match(failure(doubled.stderr).error.message, /exactly one/);
    const empty = await host(data, ["run", "--thread", "thread-1", "--session", id, "--script", "  "]);
    assert.match(failure(empty.stderr).error.message, /empty/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("run keeps its timeout inside the boundary", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    session(data, "thread-1");
    const result = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      "11111111-2222-3333-4444-555555555555",
      "--script",
      "1",
      "--timeout-ms",
      "5",
    ]);
    assert.equal(result.code, 1);
    assert.equal(failure(result.stderr).error.code, "invalid_timeout");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a ready session whose browser is gone is marked stopped", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    const dir = session(data, "thread-1");
    const result = await host(data, ["pages", "--thread", "thread-1", "--session", "11111111-2222-3333-4444-555555555555"]);
    assert.equal(result.code, 1);
    assert.equal(failure(result.stderr).error.code, "session_unavailable");
    const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    assert.equal(saved.state, "stopped");
    assert.equal(saved.reason, "gone");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

/** @param {string} data @param {number} pid */
function browserRecord(data, pid) {
  writeFileSync(
    join(data, "browser.json"),
    JSON.stringify({ pid, endpoint: "http://127.0.0.1:1", binary: "chrome", headless: true, startedAt: Date.now() }),
  );
}

test("the reaper stops an idle browser and leaves a busy one", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    browserRecord(data, 999_998);
    session(data, "thread-1", { state: "closed", pageId: "PAGE-1" });
    const idle = await host(data, ["reap", "--pid", "999998", "--after", "0"]);
    assert.deepEqual(JSON.parse(idle.stdout), { stopped: true });
    assert.equal(existsSync(join(data, "browser.json")), false);

    browserRecord(data, 999_997);
    session(data, "thread-2", { id: "22222222-2222-3333-4444-555555555555" });
    const busy = await host(data, ["reap", "--pid", "999997", "--after", "0"]);
    assert.deepEqual(JSON.parse(busy.stdout), { stopped: false, reason: "in-use" });
    assert.equal(existsSync(join(data, "browser.json")), true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("the reaper ignores a browser record it did not see", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    browserRecord(data, 999_996);
    const result = await host(data, ["reap", "--pid", "123", "--after", "0"]);
    assert.deepEqual(JSON.parse(result.stdout), { stopped: false, reason: "replaced" });
    assert.equal(existsSync(join(data, "browser.json")), true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("shutdown stops the browser without touching its profile", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    browserRecord(data, 999_995);
    mkdirSync(join(data, "profile"), { recursive: true });
    const result = await host(data, ["shutdown"]);
    assert.deepEqual(JSON.parse(result.stdout), { stopped: true });
    assert.equal(existsSync(join(data, "browser.json")), false);
    assert.equal(existsSync(join(data, "profile")), true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("an unknown command fails with JSON on stderr", async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-host-"));
  try {
    const result = await host(data, ["browse"]);
    assert.equal(result.code, 1);
    assert.equal(failure(result.stderr).error.code, "invalid_option");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
