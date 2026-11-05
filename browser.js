// @ts-check
/**
 * One Chrome for the plugin on one profile that outlives sessions, so a login
 * survives a close. A session is a tab in that browser, not a browser of its
 * own; `stop` and `close` shut the browser down only when no session is left.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserError } from "./core.js";
import * as chrome from "./chrome.js";
import { acquire, alive } from "./store.js";

const LOCK_STALE_MS = 60_000;

/** @typedef {{ pid: number, endpoint: string, binary: string, headless: boolean, startedAt: number }} Browser */

/** @param {string} data */
export function recordPath(data) {
  return join(data, "browser.json");
}

/** @param {string} data */
export function profilePath(data) {
  return join(data, "profile");
}

/**
 * @param {string} data
 * @returns {Browser|null}
 */
export function read(data) {
  const file = recordPath(data);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value.pid === "number" ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} data
 * @param {Browser} record
 */
function write(data, record) {
  mkdirSync(data, { recursive: true });
  const file = recordPath(data);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, file);
}

/** @param {string} data */
export function forget(data) {
  rmSync(recordPath(data), { force: true });
}

/**
 * The browser, if its process is still there.
 * @param {string} data
 * @returns {Browser|null}
 */
export function running(data) {
  const record = read(data);
  return record && alive(record.pid) ? record : null;
}

/**
 * The running browser, or one started on the persistent profile. Callers hold
 * the lock, because a matching stop must not interleave with a launch.
 * @param {string} data
 * @param {{ headless: boolean, chrome?: string }} options
 * @returns {Promise<Browser>}
 */
export async function ensureLocked(data, options) {
  const current = running(data);
  if (current) {
    if (current.headless !== options.headless) {
      throw new BrowserError(
        `the browser is already ${current.headless ? "headless" : "headed"}; close its sessions before opening a ${options.headless ? "headless" : "headed"} one`,
        "invalid_option",
      );
    }
    return current;
  }
  // A leftover endpoint file would name the port of a Chrome that has gone.
  rmSync(join(profilePath(data), "DevToolsActivePort"), { force: true });
  mkdirSync(profilePath(data), { recursive: true });
  const launched = await chrome.launch(profilePath(data), options.headless, options.chrome);
  const record = {
    pid: launched.pid,
    endpoint: launched.endpoint,
    binary: launched.binary,
    headless: options.headless,
    startedAt: Date.now(),
  };
  write(data, record);
  return record;
}

/**
 * Stops Chrome and forgets its endpoint. The profile stays, so logins do.
 * Callers hold the lock.
 * @param {string} data
 */
export async function stopLocked(data) {
  const record = read(data);
  if (record) await chrome.stop(record.pid);
  forget(data);
}

/**
 * Launching, stopping and tab creation share one lock: two threads may ask at
 * the same moment, and Chrome cannot open one profile twice.
 * @template T
 * @param {string} data
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function locked(data, work) {
  const lock = join(data, "browser.lock");
  await acquire(lock, LOCK_STALE_MS);
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}
