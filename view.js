// @ts-check
/**
 * What the right-sidebar page asks for: a frame of the page it watches, and a
 * click or keystroke carried back into that page.
 */
import { rmSync } from "node:fs";
import { BrowserError, PREVIEW_QUALITY, jpegSize } from "./core.js";
import { ensurePage, pageTitle } from "./driver.js";
import { withPage } from "./session.js";
import { RUN_LOCK_STALE_MS, runLockPath, takeLock, writeSession } from "./store.js";

/**
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 * @param {string|undefined} quality
 */
export async function preview(data, threadId, id, quality) {
  return withPage(data, threadId, id, async (pages, record) => {
    const target = previewPage(pages, record);
    // One viewport frame; the panel scales it, so the session keeps its size.
    const bytes = await target.screenshot({
      type: "jpeg",
      quality: clampQuality(quality),
      animations: "disabled",
      timeout: 5_000,
    });
    const size = jpegSize(bytes);
    record.sequence = (record.sequence ?? 0) + 1;
    writeSession(data, record);
    return {
      sequence: record.sequence,
      mimeType: "image/jpeg",
      data: bytes.toString("base64"),
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      // Mouse coordinates are CSS pixels; the capture is device pixels.
      scale: await target.evaluate(() => globalThis.devicePixelRatio || 1).catch(() => 1),
      url: target.url(),
      title: await pageTitle(target),
    };
  });
}

/** @param {string|undefined} value */
function clampQuality(value) {
  const quality = Number(value);
  if (!Number.isFinite(quality)) return PREVIEW_QUALITY;
  return Math.max(10, Math.min(90, Math.round(quality)));
}

/**
 * The page the panel should watch: the one the last script used, else the
 * first that is not a blank tab.
 * @param {import("./driver.js").Pages} pages
 * @param {import("./core.js").SessionRecord} record
 */
function previewPage(pages, record) {
  const all = [pages.main, ...pages.named.values()];
  const byUrl = record.url ? all.find((page) => page.url() === record.url) : undefined;
  return byUrl ?? all.find((page) => page.url() !== "about:blank") ?? pages.main;
}

/**
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 * @param {import("./core.js").InputKind} kind
 * @param {{ x?: string, y?: string, delta?: string, text?: string, key?: string, page?: string }} input
 */
export async function applyInput(data, threadId, id, kind, input) {
  const name = input.page ?? "main";
  const lock = runLockPath(data, threadId, id);
  // A person's click waits for no script: a busy session says so at once. The
  // second try clears a lock a crashed run left behind.
  if (!takeLock(lock, RUN_LOCK_STALE_MS) && !takeLock(lock, RUN_LOCK_STALE_MS)) {
    throw new BrowserError("a script is running in this session", "command_failed");
  }
  try {
    await withPage(data, threadId, id, async (pages, record) => {
      const target = await ensurePage(pages, name);
      await apply(target, kind, input);
      record.lastUsed = Date.now();
      record.url = target.url();
      record.title = await pageTitle(target);
      writeSession(data, record);
    });
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * @param {any} target
 * @param {string} kind
 * @param {{ x?: string, y?: string, delta?: string, text?: string, key?: string }} input
 */
async function apply(target, kind, input) {
  if (kind === "click") {
    const x = Number(input.x ?? 0);
    const y = Number(input.y ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new BrowserError("a click needs a place in the page", "invalid_option");
    }
    await target.mouse.click(x, y);
    return;
  }
  if (kind === "wheel") {
    await target.mouse.wheel(0, Number(input.delta ?? 0));
    return;
  }
  if (kind === "type") {
    await target.keyboard.type(String(input.text ?? ""));
    return;
  }
  if (kind === "press") {
    await target.keyboard.press(String(input.key ?? "Enter"));
    return;
  }
  throw new BrowserError(`unknown input '${kind}'`, "invalid_option");
}
