// @ts-check
/**
 * Chrome for one session: find a binary, start it with its own profile, learn
 * its debugger endpoint, and stop the whole process group again.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserError, messageOf } from "./core.js";
import { alive, sleep } from "./store.js";

const ENDPOINT_TIMEOUT_MS = 20_000;

/** @param {string|undefined} chosen */
function candidates(chosen) {
  const windows = process.env.PROGRAMFILES
    ? [
        join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : [];
  return [
    ...(chosen ? [chosen] : []),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...windows,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter((candidate) => candidate !== "");
}

/**
 * @param {string} profile
 * @param {boolean} headless
 * @param {string|undefined} chosen
 */
export async function launch(profile, headless, chosen) {
  mkdirSync(profile, { recursive: true });
  if (chosen && !existsSync(chosen)) {
    throw new BrowserError(
      `the Chrome executable set in settings does not exist: ${chosen}`,
      "setup_failed",
    );
  }
  const flags = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-sync",
    "--window-size=1280,800",
    // Plugin-owned Chrome runs on hosts that restrict unprivileged namespaces.
    "--no-sandbox",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const failures = [];
  for (const binary of candidates(chosen)) {
    let child;
    let logFd;
    try {
      logFd = openSync(join(profile, "chrome.err"), "a");
      child = spawn(binary, flags, { detached: true, stdio: ["ignore", "ignore", logFd] });
      // A missing binary reports asynchronously; the exit check below sees it.
      child.on("error", () => undefined);
    } catch (error) {
      failures.push(`${binary}: ${messageOf(error)}`);
      continue;
    } finally {
      // The child holds its own copy; this one would leak into the next attempt.
      if (logFd !== undefined) closeSync(logFd);
    }
    await sleep(150);
    if (!child.pid || !alive(child.pid)) {
      failures.push(`${binary}: exited at once`);
      continue;
    }
    try {
      const endpoint = await waitForEndpoint(profile, child.pid);
      child.unref();
      return { pid: child.pid, endpoint, binary };
    } catch (error) {
      await stop(child.pid);
      failures.push(`${binary}: ${messageOf(error)}`);
    }
  }
  throw new BrowserError(
    `Chrome or Chromium was not found. Tried: ${failures.join("; ") || "nothing"}`,
    "setup_failed",
    "Install Google Chrome, or set its path in the plugin settings.",
  );
}

/**
 * @param {string} profile
 * @param {number|undefined} pid
 */
async function waitForEndpoint(profile, pid) {
  const started = Date.now();
  while (Date.now() - started < ENDPOINT_TIMEOUT_MS) {
    if (!alive(pid)) throw new Error("Chrome exited before it opened its debugger");
    for (const file of [join(profile, "DevToolsActivePort"), join(profile, "Default", "DevToolsActivePort")]) {
      if (!existsSync(file)) continue;
      const port = readFileSync(file, "utf8").trim().split("\n")[0];
      if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for Chrome's debugger");
}

/**
 * Terminates the process group Chrome was started in, so its helpers go too.
 * @param {number|undefined} pid
 */
export async function stop(pid) {
  if (!pid) return;
  signal(pid, "SIGTERM");
  signalGroup(pid, "SIGTERM");
  const started = Date.now();
  while (alive(pid) && Date.now() - started < 2_000) await sleep(50);
  signalGroup(pid, "SIGKILL");
  if (alive(pid)) signal(pid, "SIGKILL");
}

/**
 * A group signal is best effort: the group can be gone, or macOS can refuse a
 * negative pid, and neither means the process itself is still running.
 * @param {number} pid
 * @param {NodeJS.Signals} name
 */
function signalGroup(pid, name) {
  try {
    process.kill(-pid, name);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")) {
      return;
    }
    throw error;
  }
}

/**
 * A process that is already gone is not an error; anything else is.
 * @param {number} target
 * @param {NodeJS.Signals} name
 */
function signal(target, name) {
  try {
    process.kill(target, name);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

/**
 * Kills one process and the group it leads, without waiting.
 * @param {number|undefined} pid
 */
export function terminate(pid) {
  if (!pid) return;
  signalGroup(pid, "SIGKILL");
  if (alive(pid)) signal(pid, "SIGKILL");
}
