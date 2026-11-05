// @ts-check
/**
 * The plugin's side of the bridge. Every operation is one short-lived node
 * process (`host.mjs`), because kagan gives a plugin no long-lived child.
 */
import { run } from "kagan/process";
import { settings } from "kagan/host";
import { BrowserError, errorOf, filePath, hostCommand, parseJson } from "./core.js";

/** Login/GUI PATH often lacks nvm; prefer Homebrew then nvm shims. */
const PATH_PREFIX =
  'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; ' +
  'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; ';

const HOST = filePath(new URL("./host.mjs", import.meta.url).href);

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} threadId
 * @property {"ready"|"stopped"|"closed"} state
 * @property {boolean} headless
 * @property {string} pageId
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {number} lastUsed
 * @property {string} [url]
 * @property {string} [title]
 * @property {number} [sequence]
 * @property {string} [reason]
 */
/**
 * @typedef {object} Shot
 * @property {string} path
 * @property {string} mimeType
 * @property {number} width
 * @property {number} height
 */
/**
 * @typedef {object} RunResult
 * @property {string} text
 * @property {Shot[]} images
 * @property {number} exitCode
 */
/**
 * @typedef {object} Frame
 * @property {number} sequence
 * @property {string} mimeType
 * @property {string} data base64 JPEG
 * @property {number} width
 * @property {number} height
 * @property {number} scale device pixels per CSS pixel
 * @property {string} url
 * @property {string} title
 */

function dataDir() {
  const dir = /** @type {{ dataDir?: string } | undefined} */ (globalThis.process)?.dataDir;
  if (typeof dir !== "string" || dir === "") {
    throw new BrowserError(
      "Browser Automation has no data folder; reinstall the plugin",
      "setup_failed",
    );
  }
  return dir;
}

function chromePath() {
  const value = /** @type {{ chromePath?: unknown }} */ (settings()).chromePath;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 */
async function call(command, args, timeoutMs) {
  const line = hostCommand(PATH_PREFIX, HOST, command, args, dataDir(), chromePath());
  const result = await run("bash", ["-c", line], { timeoutMs });
  if (result.exitCode !== 0) {
    throw failure(result.stderr || result.stdout);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const last = lines.at(-1) ?? "null";
  try {
    return JSON.parse(last);
  } catch {
    throw new BrowserError(`the browser host printed no JSON: ${last.slice(0, 200)}`, "command_failed");
  }
}

/** @param {string} text */
function failure(text) {
  const lines = text.trim().split("\n").reverse();
  for (const line of lines) {
    const body = parseJson(line);
    if (body?.ok === false && body.error?.message) {
      return new BrowserError(
        String(body.error.message),
        String(body.error.code ?? "command_failed"),
        String(body.error.hint ?? ""),
      );
    }
  }
  const message = text.trim() || "the browser host failed";
  const mapped = errorOf(new Error(message));
  return new BrowserError(mapped.message, mapped.code, mapped.hint);
}

/**
 * Installs the browser runtime when it is missing.
 * @returns {Promise<{ status: string, version: string, source: string }>}
 * @throws {BrowserError} when npm is missing or the install fails
 */
export function prepare() {
  return call("prepare", [], 180_000);
}

/**
 * Opens one tab in the plugin's browser for this thread.
 * @param {string} threadId
 * @param {boolean} [headed]
 * @returns {Promise<Session>}
 * @throws {BrowserError} when Chrome or the runtime is missing
 */
export function openSession(threadId, headed = false) {
  const args = ["--thread", threadId];
  if (headed) args.push("--headed");
  return call("open", args, 180_000);
}

/**
 * This thread's sessions, oldest first.
 * @param {string} threadId
 * @returns {Promise<Session[]>}
 */
export function listSessions(threadId) {
  return call("list", ["--thread", threadId], 30_000);
}

/**
 * Runs one script in the session's tab.
 * @param {string} threadId
 * @param {string} sessionId
 * @param {string} script
 * @param {number} timeoutMs
 * @returns {Promise<RunResult>}
 * @throws {BrowserError} when the session is gone, the script throws, or the
 *   capture budget is passed
 */
export function runScript(threadId, sessionId, script, timeoutMs) {
  return call(
    "run",
    ["--thread", threadId, "--session", sessionId, "--script", script, "--timeout-ms", String(timeoutMs)],
    timeoutMs + 15_000,
  );
}

/**
 * Runs a script file, resolved from the invoking working directory.
 * @param {string} threadId
 * @param {string} sessionId
 * @param {string} file
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<RunResult>}
 * @throws {BrowserError} for the same reasons as runScript
 */
export function runScriptFile(threadId, sessionId, file, cwd, timeoutMs) {
  return call(
    "run",
    ["--thread", threadId, "--session", sessionId, "--script-file", file, "--cwd", cwd, "--timeout-ms", String(timeoutMs)],
    timeoutMs + 15_000,
  );
}

/**
 * The session's pages, main first.
 * @param {string} threadId @param {string} sessionId
 * @returns {Promise<RunResult>} the text holds `[{name, url, title}]`
 */
export function pages(threadId, sessionId) {
  return call("pages", ["--thread", threadId, "--session", sessionId], 60_000);
}

/**
 * Saves a JPEG of one page and returns its path.
 * @param {string} threadId
 * @param {string} sessionId
 * @param {string} [page]
 * @returns {Promise<RunResult>}
 */
export function screenshot(threadId, sessionId, page = "main") {
  return call(
    "screenshot",
    ["--thread", threadId, "--session", sessionId, "--page", page],
    60_000,
  );
}

/**
 * A person's input, forwarded to the page in the session.
 * @param {string} threadId
 * @param {string} sessionId
 * @param {{ kind: import("./core.js").InputKind, x?: number, y?: number, delta?: number, text?: string, key?: string }} action
 * @returns {Promise<{ ok: boolean }>}
 * @throws {BrowserError} when a script is running in the session
 */
export function input(threadId, sessionId, action) {
  const args = ["--thread", threadId, "--session", sessionId, "--kind", action.kind];
  if (action.x !== undefined) args.push("--x", String(action.x));
  if (action.y !== undefined) args.push("--y", String(action.y));
  if (action.delta !== undefined) args.push("--delta", String(action.delta));
  if (action.text !== undefined) args.push("--text", action.text);
  if (action.key !== undefined) args.push("--key", action.key);
  return call("input", args, 30_000);
}

/**
 * A fresh frame of the page the panel watches. Watching does not count as use.
 * @param {string} threadId @param {string} sessionId
 * @returns {Promise<{ frame: Frame | null }>}
 */
export function preview(threadId, sessionId) {
  return call("preview", ["--thread", threadId, "--session", sessionId], 45_000);
}

/**
 * Closes the session's tab and keeps its record.
 * @param {string} threadId @param {string} sessionId
 * @returns {Promise<Session>}
 */
export function stopSession(threadId, sessionId) {
  return call("stop", ["--thread", threadId, "--session", sessionId], 30_000);
}

/**
 * Stops the session and removes its captures. The browser profile stays.
 * @param {string} threadId @param {string} sessionId
 * @returns {Promise<Session>}
 */
export function closeSession(threadId, sessionId) {
  return call("close", ["--thread", threadId, "--session", sessionId], 30_000);
}
