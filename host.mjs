#!/usr/bin/env node
// @ts-check
/**
 * Local headless Chrome sessions for the kagan browser-automation plugin.
 * Speaks JSON on stdout. Sessions keep a Chrome process alive and reconnect over CDP.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_DATA = join(homedir(), ".kagan", "plugins", "dev.kagan.browser-automation");

function fail(message, code = 1) {
  process.stderr.write(String(message).endsWith("\n") ? message : `${message}\n`);
  process.exit(code);
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

function dataRoot() {
  return arg("--data") ?? DEFAULT_DATA;
}

function sessionsDir(data) {
  return join(data, "sessions");
}

function sessionPath(data, id) {
  return join(sessionsDir(data), id);
}

function readSession(data, id) {
  const file = join(sessionPath(data, id), "session.json");
  if (!existsSync(file)) fail(`session ${id} not found`, 2);
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeSession(data, record) {
  const dir = sessionPath(data, record.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, file);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function loadPlaywright(data) {
  const runtime = join(data, "runtime");
  const pkg = join(runtime, "node_modules", "playwright-core", "package.json");
  if (!existsSync(pkg)) {
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, "package.json"),
      JSON.stringify({ private: true, dependencies: { "playwright-core": "1.63.0" } }, null, 2),
    );
    await runNpm(runtime, ["install", "--ignore-scripts", "--no-fund", "--no-audit"]);
  }
  const require = createRequire(join(runtime, "package.json"));
  return require("playwright-core");
}

function runNpm(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(stderr.trim() || `npm exited ${code}`));
    });
  });
}

function chromeCandidates() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
}

async function launchChrome(userDataDir, headless) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-sync",
    "--no-sandbox",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  let lastError = null;
  for (const bin of chromeCandidates()) {
    try {
      const errFd = openSync(join(userDataDir, "chrome.err"), "a");
      const child = spawn(bin, args, {
        detached: true,
        stdio: ["ignore", "ignore", errFd],
      });
      // New process group so close can signal every Chrome helper.
      try {
        process.kill(-child.pid, 0);
      } catch {
        /* group may not exist yet on all platforms */
      }
      child.unref();
      const endpoint = await waitForEndpoint(userDataDir, child.pid);
      return { pid: child.pid, endpoint, binary: bin };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Chrome/Chromium not found");
}

async function waitForEndpoint(userDataDir, pid) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (!alive(pid)) throw new Error("Chrome exited before DevTools was ready");
    const candidates = [
      join(userDataDir, "DevToolsActivePort"),
      join(userDataDir, "Default", "DevToolsActivePort"),
    ];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, "utf8").trim().split("\n");
      if (lines.length >= 1 && /^\d+$/.test(lines[0])) {
        // Playwright connectOverCDP wants the HTTP debugger URL.
        return `http://127.0.0.1:${lines[0]}`;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for Chrome DevTools");
}

async function connect(playwright, endpoint) {
  const browser = await playwright.chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  return { browser, context, page };
}

function pageApi(page, shotDir) {
  let shot = 0;
  return {
    async goto(url, options) {
      await page.goto(url, { waitUntil: "domcontentloaded", ...(options ?? {}) });
      return page.url();
    },
    async snapshot() {
      if (typeof page._snapshotForAI === "function") {
        return page._snapshotForAI();
      }
      const tree = await page.accessibility.snapshot({ interestingOnly: true });
      return JSON.stringify(tree, null, 2);
    },
    async click(selector) {
      if (String(selector).startsWith("ref/") || String(selector).startsWith("e")) {
        const ref = String(selector).replace(/^ref\//, "");
        await page.locator(`aria-ref=${ref}`).click({ timeout: 15_000 });
        return;
      }
      await page.locator(selector).first().click({ timeout: 15_000 });
    },
    async fill(selector, value) {
      await page.locator(selector).first().fill(String(value), { timeout: 15_000 });
    },
    async type(selector, value) {
      await page.locator(selector).first().pressSequentially(String(value), { timeout: 15_000 });
    },
    async press(key) {
      await page.keyboard.press(key);
    },
    async title() {
      return page.title();
    },
    async url() {
      return page.url();
    },
    async content() {
      return page.content();
    },
    async evaluate(fn, arg) {
      return page.evaluate(fn, arg);
    },
    async waitForSelector(selector, options) {
      await page.waitForSelector(selector, options);
    },
    async shot(options = {}) {
      mkdirSync(shotDir, { recursive: true });
      shot += 1;
      const file = join(shotDir, `shot-${shot}.jpg`);
      await page.screenshot({
        path: file,
        type: "jpeg",
        quality: options.quality ?? 70,
        fullPage: Boolean(options.fullPage),
      });
      return { path: file, mimeType: "image/jpeg" };
    },
    locator(selector) {
      return page.locator(selector);
    },
    raw: page,
  };
}

async function withSession(data, id, fn) {
  const record = readSession(data, id);
  if (record.state !== "ready") fail(`session ${id} is ${record.state}`, 2);
  if (!alive(record.pid)) fail(`session ${id} chrome is not running; open a new session`, 2);
  const playwright = await loadPlaywright(data);
  const { browser, page } = await connect(playwright, record.endpoint);
  try {
    const shotDir = join(sessionPath(data, id), "shots");
    const api = {
      getPage(name = "main") {
        if (name !== "main") throw new Error('only page "main" is available in this port');
        return pageApi(page, shotDir);
      },
      pages: async () => [{ id: "main", url: page.url(), title: await page.title() }],
    };
    return await fn(api, record, page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function cmdOpen(data) {
  const threadId = arg("--thread") ?? "none";
  const headless = !has("--headed");
  const id = randomUUID();
  const dir = sessionPath(data, id);
  mkdirSync(dir, { recursive: true });
  const userDataDir = join(dir, "chrome-profile");
  mkdirSync(userDataDir, { recursive: true });
  await loadPlaywright(data);
  const launched = await launchChrome(userDataDir, headless);
  const record = {
    id,
    threadId,
    backend: "local",
    state: "ready",
    headless,
    pid: launched.pid,
    endpoint: launched.endpoint,
    binary: launched.binary,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60_000,
  };
  writeSession(data, record);
  out(record);
}

async function cmdList(data) {
  const root = sessionsDir(data);
  if (!existsSync(root)) {
    out([]);
    return;
  }
  const { readdirSync } = await import("node:fs");
  const thread = arg("--thread");
  const list = [];
  for (const id of readdirSync(root)) {
    try {
      const record = readSession(data, id);
      if (thread && record.threadId !== thread) continue;
      if (record.state === "ready" && !alive(record.pid)) {
        record.state = "stopped";
        writeSession(data, record);
      }
      list.push(record);
    } catch {
      /* skip */
    }
  }
  out(list);
}

async function cmdRun(data) {
  const id = arg("--session");
  if (!id) fail("--session required");
  const script = arg("--script");
  const scriptFile = arg("--script-file");
  let source = script;
  if (scriptFile) source = readFileSync(scriptFile, "utf8");
  if (!source) fail("pass --script or --script-file");
  const timeoutMs = Number(arg("--timeout-ms", "30000"));
  const result = await withSession(data, id, async (browser) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction("browser", `"use strict";\n${source}`);
    const value = await Promise.race([
      run(browser),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`run timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const text =
      value === undefined || value === null
        ? ""
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2);
    return { text: text.slice(0, 160_000), images: [], exitCode: 0 };
  });
  const record = readSession(data, id);
  record.lastUsed = Date.now();
  writeSession(data, record);
  out(result);
}

async function cmdPages(data) {
  const id = arg("--session");
  if (!id) fail("--session required");
  const pages = await withSession(data, id, async (browser) => browser.pages());
  out({ text: JSON.stringify(pages, null, 2), images: [], exitCode: 0 });
}

async function cmdScreenshot(data) {
  const id = arg("--session");
  if (!id) fail("--session required");
  const result = await withSession(data, id, async (browser) => {
    const page = browser.getPage("main");
    const image = await page.shot();
    return {
      text: image.path,
      images: [image],
      exitCode: 0,
    };
  });
  out(result);
}

async function killChrome(pid) {
  if (!pid) return;
  // Detached Chrome often leaves children; signal the process group when possible.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  const started = Date.now();
  while (alive(pid) && Date.now() - started < 3_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 300));
}

async function cmdStop(data) {
  const id = arg("--session");
  if (!id) fail("--session required");
  const record = readSession(data, id);
  await killChrome(record.pid);
  record.state = "stopped";
  writeSession(data, record);
  out(record);
}

async function cmdClose(data) {
  const id = arg("--session");
  if (!id) fail("--session required");
  const record = readSession(data, id);
  await killChrome(record.pid);
  record.state = "closed";
  writeSession(data, record);
  // Keep session.json for list history; drop chrome profile + shots.
  rmSync(join(sessionPath(data, id), "chrome-profile"), { recursive: true, force: true });
  rmSync(join(sessionPath(data, id), "shots"), { recursive: true, force: true });
  out(record);
}

async function cmdPrepare(data) {
  await loadPlaywright(data);
  out({ status: "ready", version: "1.63.0", source: "playwright-core" });
}

const command = process.argv[2];
const data = dataRoot();
mkdirSync(data, { recursive: true });

const commands = {
  prepare: cmdPrepare,
  open: cmdOpen,
  list: cmdList,
  run: cmdRun,
  pages: cmdPages,
  screenshot: cmdScreenshot,
  stop: cmdStop,
  close: cmdClose,
};

if (!commands[command]) {
  fail(`unknown command ${command ?? ""}. use prepare|open|list|run|pages|screenshot|stop|close`);
}

commands[command](data).catch((error) => fail(error instanceof Error ? error.message : String(error)));
