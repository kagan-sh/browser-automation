#!/usr/bin/env node
// @ts-check
/**
 * Runs one script in its own process, so `host.mjs` can kill a script that
 * never returns. Prints one JSON result on stdout, or a JSON error on stderr.
 */
import { readFileSync } from "node:fs";
import { browserApi, connectOver, pageById, pageStore, pageTitle, sessionPages } from "./driver.js";
import { BrowserError, clipText, errorBody, imageFailure } from "./core.js";

/** @param {string} name @param {string} [fallback] */
function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const runtime = arg("--runtime");
const endpoint = arg("--endpoint");
const shots = arg("--shots");
const pagesFile = arg("--pages");
const pageId = arg("--page");
const file = arg("--script");

try {
  if (!runtime || !endpoint || !shots || !pagesFile || !pageId || !file) {
    throw new BrowserError(
      "the runner needs --runtime, --endpoint, --page, --shots, --pages and --script",
      "invalid_option",
    );
  }
  const source = readFileSync(file, "utf8");
  const { browser, context } = await connectOver(runtime, endpoint);
  try {
    const main = await pageById(context, pageId);
    if (!main) {
      throw new BrowserError("the session's tab is closed; open a new session", "session_unavailable");
    }
    const pages = await sessionPages(context, main, pageStore(pagesFile));
    const api = browserApi(pages, shots);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const script = new AsyncFunction("browser", `"use strict";\n${source}`);
    const value = await script(api);
    const failure = imageFailure(api.images);
    if (failure) throw new BrowserError(failure, "screenshot_limit");
    const text =
      value === undefined || value === null
        ? ""
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2);
    const last = api.last();
    process.stdout.write(
      JSON.stringify({
        text: clipText(text),
        images: api.images.map(({ path, mimeType, width, height }) => ({ path, mimeType, width, height })),
        url: last.url(),
        title: await pageTitle(last),
      }),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorBody(error))}\n`);
  process.exitCode = 1;
}
