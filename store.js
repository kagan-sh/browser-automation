// @ts-check
/**
 * Session records and the locks around them. One folder per thread, one folder
 * per session, written atomically so a crash leaves a readable record.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BrowserError } from "./core.js";

/** @param {string} data @param {string} threadId */
export function threadDir(data, threadId) {
  return join(data, "sessions", encodeURIComponent(threadId));
}

/** @param {string} data @param {string} threadId @param {string} id */
export function sessionPath(data, threadId, id) {
  return join(threadDir(data, threadId), id);
}

/** A lock older than this is assumed to belong to a run that died. */
export const RUN_LOCK_STALE_MS = 150_000;

/**
 * The one lock a session's script and a person's input share.
 * @param {string} data @param {string} threadId @param {string} id
 */
export function runLockPath(data, threadId, id) {
  return join(sessionPath(data, threadId, id), "run.lock");
}

/** @param {string|undefined} threadId */
export function requiredThread(threadId) {
  if (!threadId) throw new BrowserError("pass --thread <id>", "invalid_option");
  return threadId;
}

/**
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 * @returns {import("./core.js").SessionRecord}
 */
export function readSession(data, threadId, id) {
  const file = join(sessionPath(data, threadId, id), "session.json");
  if (!existsSync(file)) {
    throw new BrowserError(`session ${id} not found`, "session_unavailable");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * @param {string} data
 * @param {import("./core.js").SessionRecord} record
 */
export function writeSession(data, record) {
  const dir = sessionPath(data, record.threadId, record.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, file);
}

/**
 * @param {string} data
 * @param {string} threadId
 * @returns {import("./core.js").SessionRecord[]}
 */
export function allSessions(data, threadId) {
  const dir = threadDir(data, threadId);
  if (!existsSync(dir)) return [];
  const sessions = [];
  for (const id of readdirSafe(dir)) {
    if (!existsSync(join(dir, id, "session.json"))) continue;
    sessions.push(readSession(data, threadId, id));
  }
  return sessions;
}

/**
 * Every session on this machine, whatever thread it belongs to.
 * @param {string} data
 * @returns {import("./core.js").SessionRecord[]}
 */
export function everySession(data) {
  const root = join(data, "sessions");
  if (!existsSync(root)) return [];
  const sessions = [];
  for (const thread of readdirSafe(root)) {
    sessions.push(...allSessions(data, decodeURIComponent(thread)));
  }
  return sessions;
}

/** @param {string} dir */
function readdirSafe(dir) {
  try {
    return /** @type {string[]} */ (readdirSync(dir));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** @param {number|undefined} pid */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One non-blocking attempt at the lock: true when this process took it, false
 * while someone else holds it. Any error but "already locked" surfaces.
 * @param {string} path
 * @param {number} staleMs
 * @returns {boolean}
 */
export function takeLock(path, staleMs) {
  try {
    const fd = openSync(path, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  try {
    if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return false;
}

/**
 * Waits for a lock another process may hold, up to the stale limit, then throws.
 * Use this when waiting is fine; use takeLock for one attempt.
 * @param {string} path
 * @param {number} staleMs
 * @throws {BrowserError}
 */
export async function acquire(path, staleMs) {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  while (!takeLock(path, staleMs)) {
    if (Date.now() - started > staleMs) {
      throw new BrowserError("another script is still running in this session", "command_failed");
    }
    await sleep(50);
  }
}
