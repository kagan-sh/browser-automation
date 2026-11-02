// @ts-check

import { run } from "kagan/process";
import { log } from "kagan/host";

/** Login/GUI PATH often lacks nvm; prefer Homebrew then nvm shims. */
const PATH_PREFIX =
  'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; ' +
  'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; ';

/**
 * @param {string} command
 * @param {string[]} extra
 * @param {{ timeoutMs?: number }} [options]
 */
export async function host(command, extra = [], options = {}) {
  const data = /** @type {{ dataDir?: string }} */ (globalThis.process)?.dataDir;
  const args = ["host.mjs", command, ...extra];
  if (data) args.push("--data", data);
  const shell = PATH_PREFIX + "node " + args.map(shellQuote).join(" ");
  const result = await run("bash", ["-c", shell], {
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (result.exitCode !== 0) {
    const message = (result.stderr || result.stdout || `host ${command} failed`).trim();
    log("warn", message);
    throw new Error(message);
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`host ${command} returned non-JSON: ${line.slice(0, 200)}`);
  }
}

/** @param {string} value */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function prepare() {
  return host("prepare", [], { timeoutMs: 180_000 });
}

/** @param {{ threadId?: string; headed?: boolean }} [opts] */
export function openSession(opts = {}) {
  const extra = [];
  if (opts.threadId) extra.push("--thread", opts.threadId);
  if (opts.headed) extra.push("--headed");
  return host("open", extra, { timeoutMs: 120_000 });
}

/** @param {string} [threadId] */
export function listSessions(threadId) {
  const extra = threadId ? ["--thread", threadId] : [];
  return host("list", extra);
}

/**
 * @param {string} sessionId
 * @param {string} script
 * @param {number} [timeoutMs]
 */
export function runScript(sessionId, script, timeoutMs = 30_000) {
  return host(
    "run",
    ["--session", sessionId, "--script", script, "--timeout-ms", String(timeoutMs)],
    { timeoutMs: timeoutMs + 5_000 },
  );
}

/** @param {string} sessionId */
export function pages(sessionId) {
  return host("pages", ["--session", sessionId]);
}

/** @param {string} sessionId */
export function screenshot(sessionId) {
  return host("screenshot", ["--session", sessionId], { timeoutMs: 60_000 });
}

/** @param {string} sessionId */
export function stopSession(sessionId) {
  return host("stop", ["--session", sessionId]);
}

/** @param {string} sessionId */
export function closeSession(sessionId) {
  return host("close", ["--session", sessionId]);
}
