// @ts-check
/**
 * Playwright over CDP: the pages of a session and the API a script sees. Both
 * `host.mjs` (short commands) and `runner.mjs` (a script, in its own process so
 * a hung one can be killed) use this one description of a page.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { BrowserError, jpegSize } from "./core.js";

const PAGE_NAME = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * One session's pages: the tab it owns, the named tabs it created, and the
 * name-to-target-id file that remembers them.
 * @typedef {{ main: any, named: Map<string, any>, context: any, names: Record<string, string>, store?: ReturnType<typeof pageStore> }} Pages
 */

/**
 * @param {string} runtime the plugin's runtime folder, which holds playwright-core
 */
export function playwrightFrom(runtime) {
  const require = createRequire(join(runtime, "package.json"));
  return require("playwright-core");
}

/**
 * @param {string} runtime
 * @param {string} endpoint
 */
export async function connectOver(runtime, endpoint) {
  const playwright = playwrightFrom(runtime);
  const browser = await playwright.chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { browser, context };
}

/**
 * Page names outlive a run as a file of name -> CDP target id, because a tab
 * keeps its target id across navigation and a new connection.
 * @param {string} file
 */
export function pageStore(file) {
  return {
    load() {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        return saved && typeof saved === "object" ? saved : {};
      } catch {
        return {};
      }
    },
    /** @param {Record<string, string>} names */
    save(names) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(names, null, 2));
    },
  };
}

/**
 * A tab's CDP target id: stable across navigation, so a session can find its
 * own tab again after a reconnection.
 * @param {any} page
 */
export async function targetId(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return String(targetInfo.targetId);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * The pages of one session: its own main tab, plus the named tabs it created.
 * @param {any} context
 * @param {any} main
 * @param {ReturnType<typeof pageStore>} [store]
 * @returns {Promise<Pages>}
 */
export async function sessionPages(context, main, store) {
  /** @type {Record<string, string>} */
  const names = store ? store.load() : {};
  /** @type {Map<string, any>} */
  const named = new Map();
  for (const page of context.pages()) {
    if (page === main) continue;
    const id = await targetId(page).catch(() => "");
    if (id === "") continue;
    const name = Object.keys(names).find((key) => key !== "main" && names[key] === id);
    if (name) named.set(name, page);
  }
  return { main, named, context, names, store };
}

/**
 * The tab with this target id, or null when it has been closed.
 * @param {any} context
 * @param {string} id
 */
export async function pageById(context, id) {
  for (const page of context.pages()) {
    if ((await targetId(page).catch(() => "")) === id) return page;
  }
  return null;
}

/**
 * @param {Pages} pages
 * @param {string} name
 */
export async function ensurePage(pages, name) {
  if (name === "main") return pages.main;
  if (!PAGE_NAME.test(name)) {
    throw new BrowserError(
      `page name '${name}' may use letters, digits, dot, dash and underscore`,
      "invalid_option",
    );
  }
  const found = pages.named.get(name);
  if (found) return found;
  const page = await pages.context.newPage();
  pages.named.set(name, page);
  // A target id survives navigation, so the name does too.
  const id = await targetId(page).catch(() => "");
  if (id && pages.store) {
    pages.names[name] = id;
    pages.store.save(pages.names);
  }
  return page;
}

/** @param {any} page */
export async function pageTitle(page) {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

/**
 * @param {Pages} pages
 */
export async function listPages(pages) {
  const list = [{ name: "main", url: pages.main.url(), title: await pageTitle(pages.main) }];
  for (const [name, page] of pages.named) {
    list.push({ name, url: page.url(), title: await pageTitle(page) });
  }
  return list;
}

/** @typedef {{ path: string, mimeType: string, width: number, height: number, bytes: number }} Shot */

/**
 * One page's helpers plus the browser facade a script receives.
 *
 * `getPage` is get-or-create: a known name returns its tab, an unknown one opens
 * a tab and writes the name to `pages.json`. It also marks the page it returned
 * as the last one used, which is how a run reports the URL the person watched.
 * @param {Pages} pages
 * @param {string} shots
 */
export function browserApi(pages, shots) {
  /** @type {Shot[]} */
  const images = [];
  const counter = { shot: existsSync(shots) ? readdirSync(shots).length : 0 };
  /** @type {Map<string, any>} */
  const built = new Map();
  async function forPage(name) {
    const found = built.get(name);
    if (found) return found;
    const api = pageApi(await ensurePage(pages, name), shots, images, counter);
    built.set(name, api);
    return api;
  }
  /** @type {any} */
  let last = pages.main;
  return {
    images,
    last: () => last,
    async getPage(name = "main") {
      const page = await forPage(String(name));
      last = page.raw;
      return page;
    },
    async listPages() {
      return listPages(pages);
    },
    async pages() {
      return listPages(pages);
    },
    raw: pages.main,
  };
}

/**
 * @param {any} page
 * @param {string} shots
 * @param {Shot[]} images
 * @param {{ shot: number }} counter
 */
function pageApi(page, shots, images, counter) {
  return {
    async goto(url, options) {
      await page.goto(url, { waitUntil: "domcontentloaded", ...(options ?? {}) });
      return page.url();
    },
    async snapshot(options) {
      // `mode: "ai"` is what gives each element a ref like e12.
      return page.ariaSnapshot({ mode: "ai", ...(options ?? {}) });
    },
    async click(selector) {
      const text = String(selector);
      if (/^(ref\/)?e\d+$/.test(text)) {
        // Refs come from a snapshot; a later run takes a fresh one to find them.
        await page.ariaSnapshot({ mode: "ai" });
        await page.locator(`aria-ref=${text.replace(/^ref\//, "")}`).click({ timeout: 15_000 });
        return;
      }
      await page.locator(text).first().click({ timeout: 15_000 });
    },
    async fill(selector, value) {
      await page.locator(String(selector)).first().fill(String(value), { timeout: 15_000 });
    },
    async type(selector, value) {
      await page.locator(String(selector)).first().pressSequentially(String(value), { timeout: 15_000 });
    },
    async press(key) {
      await page.keyboard.press(String(key));
    },
    async title() {
      return pageTitle(page);
    },
    async url() {
      return page.url();
    },
    async content() {
      return page.content();
    },
    async evaluate(fn, value) {
      return page.evaluate(fn, value);
    },
    async waitForSelector(selector, options) {
      await page.waitForSelector(String(selector), options);
    },
    async shot(options = {}) {
      mkdirSync(shots, { recursive: true });
      counter.shot += 1;
      const file = join(shots, `shot-${counter.shot}.jpg`);
      await page.screenshot({
        path: file,
        type: "jpeg",
        quality: Number(options.quality ?? 70),
        fullPage: Boolean(options.fullPage),
      });
      const bytes = readFileSync(file);
      const size = jpegSize(bytes) ?? { width: 0, height: 0 };
      images.push({ path: file, mimeType: "image/jpeg", ...size, bytes: bytes.length });
      return { path: file, mimeType: "image/jpeg" };
    },
    locator(selector) {
      return page.locator(String(selector));
    },
    raw: page,
  };
}
