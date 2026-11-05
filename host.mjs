#!/usr/bin/env node
// @ts-check
/**
 * The node half of the plugin: one short-lived process per call, speaking JSON
 * on stdout. The plugin runs it through `bash` so a GUI PATH still finds
 * Homebrew or nvm. Chrome, the runtime install and the records live in their
 * own modules; this file is the commands.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BROWSER_GRACE_MS,
  BrowserError,
  MAX_SESSIONS,
  SCRIPT_LIMIT,
  SESSION_TTL_MS,
  TIMEOUT_DEFAULT_MS,
  assertOwner,
  errorBody,
  expireRecord,
  filePath,
  liveness,
  parseJson,
  unavailable,
} from "./core.js";
import { browserApi, connectOver, ensurePage, listPages, pageTitle, targetId } from "./driver.js";
import { boundedTimeout } from "./cli.js";
import * as browser from "./browser.js";
import * as chrome from "./chrome.js";
import * as runtime from "./runtime.js";
import { anyReady, closeTab, requireSession, withPage } from "./session.js";
import {
  RUN_LOCK_STALE_MS,
  acquire,
  allSessions,
  readSession,
  requiredThread,
  runLockPath,
  sessionPath,
  takeLock,
  threadDir,
  writeSession,
} from "./store.js";
import { applyInput, preview } from "./view.js";

const DEFAULT_DATA = join(homedir(), ".kagan", "plugins", "dev.kagan.browser-automation", "data");
const RUNNER = filePath(new URL("./runner.mjs", import.meta.url).href);

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

/** @param {unknown} error */
function fail(error) {
  process.stderr.write(`${JSON.stringify(errorBody(error))}\n`);
  process.exit(1);
}

/** @param {unknown} value */
function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** @param {string} name @param {string} [fallback] */
function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

/** @param {string} name */
function has(name) {
  return process.argv.includes(name);
}

function dataRoot() {
  return arg("--data") ?? DEFAULT_DATA;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** @param {string} data */
async function cmdPrepare(data) {
  out(await runtime.prepare(data));
}

/** @param {string} data */
async function cmdOpen(data) {
  const threadId = requiredThread(arg("--thread"));
  const headless = !has("--headed");
  mkdirSync(threadDir(data, threadId), { recursive: true });
  const live = allSessions(data, threadId).filter(
    (record) => record.state === "ready" && liveness(record, Date.now()) === "ok",
  );
  if (live.length >= MAX_SESSIONS) {
    throw new BrowserError(
      `this thread already has ${MAX_SESSIONS} sessions; close one first`,
      "setup_failed",
    );
  }
  await runtime.ensure(data);
  const id = randomUUID();
  // A session is one tab in the plugin's shared browser. Holding the browser
  // lock keeps a matching stop from taking the browser away mid-open.
  const record = await browser.locked(data, async () => {
    // With no session using it, an idle browser can change to the asked mode.
    const current = browser.running(data);
    if (current && current.headless !== headless && !anyReady(data)) {
      await browser.stopLocked(data);
    }
    const connection = await browser.ensureLocked(data, { headless, chrome: arg("--chrome") });
    const { browser: connected, context } = await connectOver(runtime.path(data), connection.endpoint);
    try {
      const page = await context.newPage();
      await page.goto("about:blank").catch(() => undefined);
      const now = Date.now();
      /** @type {import("./core.js").SessionRecord} */
      const created = {
        id,
        threadId,
        state: "ready",
        headless,
        pageId: await targetId(page),
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        lastUsed: now,
        url: "about:blank",
        title: "",
        sequence: 0,
      };
      writeSession(data, created);
      return created;
    } finally {
      await connected.close().catch(() => undefined);
    }
  });
  out(record);
}

/** @param {string} data */
async function cmdList(data) {
  const threadId = requiredThread(arg("--thread"));
  const sessions = allSessions(data, threadId);
  const up = browser.running(data) !== null;
  for (const record of sessions) {
    if (expireRecord(record, Date.now())) {
      writeSession(data, record);
    } else if (record.state === "ready" && !up) {
      record.state = "stopped";
      record.reason = "gone";
      writeSession(data, record);
    }
  }
  sessions.sort((left, right) => left.createdAt - right.createdAt);
  if (!anyReady(data)) scheduleStop(data);
  out(sessions);
}

/** @param {string} data */
async function cmdRun(data) {
  const threadId = requiredThread(arg("--thread"));
  const id = sessionArgument();
  const timeoutMs = boundedTimeout(arg("--timeout-ms", String(TIMEOUT_DEFAULT_MS)));
  const source = readScript();
  const dir = sessionPath(data, threadId, id);
  const lock = runLockPath(data, threadId, id);
  await acquire(lock, RUN_LOCK_STALE_MS);
  try {
    const { record, connection } = requireSession(data, threadId, id);
    const scriptFile = join(dir, "script.js");
    writeFileSync(scriptFile, source);
    try {
      const result = await execute(data, record, connection, scriptFile, timeoutMs);
      record.lastUsed = Date.now();
      record.url = result.url;
      record.title = result.title;
      writeSession(data, record);
      out({ text: result.text, images: result.images, exitCode: 0 });
    } finally {
      rmSync(scriptFile, { force: true });
    }
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * The script runs in its own process, so a loop that never yields cannot hold
 * the host open: the timeout kills the process group and stops the session.
 * @param {string} data
 * @param {import("./core.js").SessionRecord} record
 * @param {import("./browser.js").Browser} connection
 * @param {string} scriptFile
 * @param {number} timeoutMs
 */
async function execute(data, record, connection, scriptFile, timeoutMs) {
  const dir = sessionPath(data, record.threadId, record.id);
  const child = spawn(
    process.execPath,
    [
      RUNNER,
      "--runtime",
      runtime.path(data),
      "--endpoint",
      connection.endpoint,
      "--page",
      record.pageId,
      "--shots",
      join(dir, "shots"),
      "--pages",
      join(dir, "pages.json"),
      "--script",
      scriptFile,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    chrome.terminate(child.pid);
    await new Promise((resolve) => child.on("close", resolve));
    record.state = "stopped";
    record.reason = "timeout";
    writeSession(data, record);
    if (!anyReady(data)) scheduleStop(data);
    throw unavailable(record);
  }
  if (outcome !== 0) throw runnerFailure(stderr, Number(outcome));
  try {
    return JSON.parse(stdout);
  } catch {
    throw new BrowserError("the script runner printed no result", "command_failed");
  }
}

/** @param {string} stderr @param {number} code */
function runnerFailure(stderr, code) {
  for (const line of stderr.trim().split("\n").reverse()) {
    const body = parseJson(line);
    if (body?.error?.message) {
      return new BrowserError(
        String(body.error.message),
        String(body.error.code ?? "command_failed"),
        String(body.error.hint ?? ""),
      );
    }
  }
  return new BrowserError(stderr.trim() || `the script runner exited ${code}`, "command_failed");
}

function readScript() {
  const script = arg("--script");
  const file = arg("--script-file");
  if ((script === undefined) === (file === undefined)) {
    throw new BrowserError("pass exactly one of --script or --script-file", "invalid_option");
  }
  const source =
    file === undefined
      ? script ?? ""
      : readFileSync(resolve(arg("--cwd") ?? process.cwd(), file), "utf8");
  if (source.trim() === "") throw new BrowserError("the script is empty", "invalid_option");
  if (source.length > SCRIPT_LIMIT) {
    throw new BrowserError(`the script is longer than ${SCRIPT_LIMIT} characters`, "invalid_option");
  }
  return source;
}

/** @param {string} data */
async function cmdPages(data) {
  const threadId = requiredThread(arg("--thread"));
  const id = sessionArgument();
  const result = await withPage(data, threadId, id, async (pages, record) => {
    const list = await listPages(pages);
    record.lastUsed = Date.now();
    writeSession(data, record);
    return { text: JSON.stringify(list, null, 2), images: [], exitCode: 0 };
  });
  out(result);
}

/** @param {string} data */
async function cmdScreenshot(data) {
  const threadId = requiredThread(arg("--thread"));
  const id = sessionArgument();
  const name = arg("--page", "main") ?? "main";
  const shots = join(sessionPath(data, threadId, id), "shots");
  const result = await withPage(data, threadId, id, async (pages, record) => {
    const target = await ensurePage(pages, name);
    const browser = browserApi(pages, shots);
    const page = await browser.getPage(name);
    const image = await page.shot({ quality: 70 });
    const shot = browser.images.at(-1);
    record.lastUsed = Date.now();
    record.url = target.url();
    record.title = await pageTitle(target);
    writeSession(data, record);
    return {
      text: image.path,
      images: [
        {
          path: image.path,
          mimeType: "image/jpeg",
          width: shot?.width ?? 0,
          height: shot?.height ?? 0,
        },
      ],
      exitCode: 0,
    };
  });
  out(result);
}

/** @param {string} data */
async function cmdPreview(data) {
  const threadId = requiredThread(arg("--thread"));
  const id = sessionArgument();
  out({ frame: await preview(data, threadId, id, arg("--quality")) });
}

/** @param {string} data */
async function cmdInput(data) {
  const threadId = requiredThread(arg("--thread"));
  const id = sessionArgument();
  await applyInput(data, threadId, id, arg("--kind") ?? "", {
    x: arg("--x"),
    y: arg("--y"),
    delta: arg("--delta"),
    text: arg("--text"),
    key: arg("--key"),
    page: arg("--page", "main"),
  });
  out({ ok: true });
}

function sessionArgument() {
  const id = arg("--session");
  if (!id) throw new BrowserError("pass --session <id>", "invalid_option");
  return id;
}

/** @param {string} data */
async function cmdStop(data) {
  const threadId = requiredThread(arg("--thread"));
  out(await endSession(data, threadId, sessionArgument(), "stopped"));
}

/** @param {string} data */
async function cmdClose(data) {
  const threadId = requiredThread(arg("--thread"));
  const id = sessionArgument();
  const record = await endSession(data, threadId, id, "closed");
  const dir = sessionPath(data, threadId, id);
  rmSync(join(dir, "shots"), { recursive: true, force: true });
  out(record);
}

/**
 * Closes the session's tab, then the shared browser when it was the last
 * session using it. The profile, and every login in it, stays on disk.
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 * @param {"stopped" | "closed"} state
 */
async function endSession(data, threadId, id, state) {
  const record = await browser.locked(data, async () => {
    const found = readSession(data, threadId, id);
    assertOwner(found, threadId);
    await closeTab(data, found);
    found.state = state;
    found.reason = state;
    writeSession(data, found);
    return found;
  });
  // Chrome keeps its cookies (and session-only logins) while it stays up; the
  // reaper stops it after the grace, unless another session uses it.
  if (!anyReady(data)) scheduleStop(data);
  return record;
}

/**
 * A detached process stops the idle browser after the grace, even if kagan has
 * quit in the meantime. Several may run; each checks the browser it saw.
 * @param {string} data
 */
function scheduleStop(data) {
  const current = browser.read(data);
  if (!current) return;
  // One reaper per idle period; the panel polls the list, so this must not
  // spawn a sleeper on every look.
  if (!takeLock(join(data, "reap.lock"), BROWSER_GRACE_MS + 60_000)) return;
  const child = spawn(
    process.execPath,
    [
      filePath(new URL(import.meta.url).href),
      "reap",
      "--data",
      data,
      "--pid",
      String(current.pid),
      "--after",
      String(BROWSER_GRACE_MS),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/**
 * @param {string} data
 */
async function cmdReap(data) {
  const pid = Number(arg("--pid", "0"));
  const after = Number(arg("--after", "0"));
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, after)));
  try {
    const current = browser.read(data);
    if (!current || current.pid !== pid) {
      out({ stopped: false, reason: "replaced" });
      return;
    }
    if (anyReady(data)) {
      out({ stopped: false, reason: "in-use" });
      return;
    }
    await browser.locked(data, () => browser.stopLocked(data));
    out({ stopped: true });
  } finally {
    rmSync(join(data, "reap.lock"), { force: true });
  }
}

/** Stops the browser now, keeping its profile. */
async function cmdShutdown(data) {
  await browser.locked(data, () => browser.stopLocked(data));
  out({ stopped: true });
}

const commands = {
  prepare: cmdPrepare,
  open: cmdOpen,
  list: cmdList,
  run: cmdRun,
  pages: cmdPages,
  screenshot: cmdScreenshot,
  preview: cmdPreview,
  input: cmdInput,
  reap: cmdReap,
  shutdown: cmdShutdown,
  stop: cmdStop,
  close: cmdClose,
};

const command = process.argv[2];
const data = dataRoot();
mkdirSync(data, { recursive: true });

const handler = commands[command];
if (!handler) {
  fail(new BrowserError(`unknown command '${command ?? ""}'`, "invalid_option"));
} else {
  Promise.resolve(handler(data)).catch(fail);
}
