// @ts-check
/**
 * A session as the commands use it: the record with its ownership and lifetime
 * checked, its own tab in the shared browser, and one CDP connection for the
 * length of a call.
 */
import { join } from "node:path";
import { assertOwner, expireRecord, liveness, unavailable } from "./core.js";
import { connectOver, pageById, pageStore, sessionPages } from "./driver.js";
import * as browser from "./browser.js";
import * as runtime from "./runtime.js";
import { everySession, readSession, sessionPath, writeSession } from "./store.js";

/**
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 */
export function pagesStore(data, threadId, id) {
  return pageStore(join(sessionPath(data, threadId, id), "pages.json"));
}

/**
 * The record, if it is this thread's and still usable. Expired and idle
 * sessions are marked stopped here, so every command reports the same thing.
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 */
export function requireSession(data, threadId, id) {
  const record = readSession(data, threadId, id);
  assertOwner(record, threadId);
  const now = Date.now();
  if (expireRecord(record, now)) {
    writeSession(data, record);
    throw unavailable(record);
  }
  if (liveness(record, now) !== "ok") throw unavailable(record);
  const connection = browser.running(data);
  if (!connection) {
    record.state = "stopped";
    record.reason = "gone";
    writeSession(data, record);
    throw unavailable(record);
  }
  return { record, connection };
}

/**
 * @param {string} data
 * @param {string} threadId
 * @param {string} id
 * @param {(pages: Awaited<ReturnType<typeof sessionPages>>, record: import("./core.js").SessionRecord) => Promise<any>} work
 */
export async function withPage(data, threadId, id, work) {
  const { record, connection } = requireSession(data, threadId, id);
  const { browser: connected, context } = await connectOver(runtime.path(data), connection.endpoint);
  try {
    const main = await pageById(context, record.pageId);
    if (!main) {
      record.state = "stopped";
      record.reason = "page";
      writeSession(data, record);
      throw unavailable(record);
    }
    const pages = await sessionPages(context, main, pagesStore(data, threadId, id));
    return await work(pages, record);
  } finally {
    await connected.close().catch(() => undefined);
  }
}

/**
 * Closes the session's tab, leaving the rest of the browser alone. Callers hold
 * the browser lock.
 * @param {string} data
 * @param {import("./core.js").SessionRecord} record
 */
export async function closeTab(data, record) {
  const connection = browser.running(data);
  if (!connection || !record.pageId) return;
  const { browser: connected, context } = await connectOver(runtime.path(data), connection.endpoint);
  try {
    const page = await pageById(context, record.pageId);
    if (page) await page.close().catch(() => undefined);
  } finally {
    await connected.close().catch(() => undefined);
  }
}

/**
 * Whether a session anywhere is still usable, so the shared browser has a
 * reason to stay up.
 * @param {string} data
 */
export function anyReady(data) {
  const now = Date.now();
  return everySession(data).some(
    (record) => record.state === "ready" && liveness(record, now) === "ok",
  );
}
