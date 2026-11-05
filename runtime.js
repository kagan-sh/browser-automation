// @ts-check
/**
 * The browser runtime: playwright-core, installed once into the plugin's data
 * folder, from one pinned release, with no global install.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserError, PLAYWRIGHT_VERSION } from "./core.js";
import { sleep, takeLock } from "./store.js";

const INSTALL_TIMEOUT_MS = 180_000;
const INSTALL_STALE_MS = 10 * 60_000;

/**
 * @param {string} data
 * @returns {Promise<{ status: string, version: string, source: string }>}
 */
export async function prepare(data) {
  await ensure(data);
  return { status: "ready", version: PLAYWRIGHT_VERSION, source: "playwright-core" };
}

/** @param {string} data */
export function path(data) {
  return join(data, "runtime");
}

/**
 * The runtime folder, installed on first use.
 * @param {string} data
 */
export async function ensure(data) {
  const runtime = path(data);
  if (installedVersion(runtime) !== PLAYWRIGHT_VERSION) await install(runtime);
  return runtime;
}

/**
 * The version on disk, or "" when nothing usable is installed.
 * @param {string} runtime
 */
function installedVersion(runtime) {
  const pkg = join(runtime, "node_modules", "playwright-core", "package.json");
  if (!existsSync(pkg)) return "";
  try {
    const value = JSON.parse(readFileSync(pkg, "utf8"));
    return typeof value.version === "string" ? value.version : "";
  } catch {
    return "";
  }
}

/** @param {string} runtime */
async function install(runtime) {
  mkdirSync(runtime, { recursive: true });
  const lock = join(runtime, "install.lock");
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (!takeLock(lock, INSTALL_STALE_MS)) {
    if (Date.now() > deadline) {
      throw new BrowserError(
        "another install of playwright-core is still running",
        "setup_failed",
        `Delete ${lock} if no install is running.`,
      );
    }
    await sleep(100);
  }
  try {
    if (installedVersion(runtime) === PLAYWRIGHT_VERSION) return;
    writeFileSync(
      join(runtime, "package.json"),
      JSON.stringify({ private: true, dependencies: { "playwright-core": PLAYWRIGHT_VERSION } }, null, 2),
    );
    await npm(runtime, ["install", "--ignore-scripts", "--no-fund", "--no-audit"]);
    if (installedVersion(runtime) !== PLAYWRIGHT_VERSION) {
      throw new BrowserError(
        `npm did not install playwright-core ${PLAYWRIGHT_VERSION}`,
        "setup_failed",
      );
    }
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * @param {string} runtime
 * @param {string[]} args
 */
function npm(runtime, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd: runtime, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new BrowserError(`npm is needed to install playwright-core: ${error.message}`, "setup_failed"),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new BrowserError(stderr.trim() || `npm exited ${code}`, "setup_failed"));
    });
  });
}
