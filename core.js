// @ts-check
/**
 * Logic the plugin script and the node host share: command parsing, session
 * lifetime and ownership, result limits. No browser and no file system here.
 */

export const PLAYWRIGHT_VERSION = "1.63.0";
export const SESSION_TTL_MS = 30 * 60_000;
export const IDLE_TTL_MS = 5 * 60_000;
export const MAX_SESSIONS = 64;
/** How long Chrome stays up with no session, so a quick reopen keeps its cookies. */
export const BROWSER_GRACE_MS = 10 * 60_000;
export const MAX_IMAGES = 4;
export const IMAGE_BYTES = 500 * 1024;
export const SCRIPT_LIMIT = 128_000;
export const TEXT_LIMIT = 160_000;
export const TIMEOUT_MIN_MS = 1_000;
export const TIMEOUT_MAX_MS = 120_000;
export const TIMEOUT_DEFAULT_MS = 30_000;
export const PREVIEW_QUALITY = 45;

export const REOPEN_HINT =
  "Open a new session with `kg browser-automation open`; it keeps a fresh Chrome profile.";

/** @typedef {"ready" | "stopped" | "closed"} SessionState */
/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} threadId
 * @property {SessionState} state
 * @property {boolean} headless
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {number} lastUsed
 * @property {string} [pageId] the tab in the shared browser
 * @property {string} [reason]
 * @property {string} [url]
 * @property {string} [title]
 * @property {number} [sequence]
 */

/** @typedef {"click" | "wheel" | "type" | "press"} InputKind */

export class BrowserError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {string} [hint]
   */
  constructor(message, code = "command_failed", hint = "") {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.hint = hint;
  }
}

/** @param {unknown} error */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The code and hint a caller sees for an error that came from the host or
 * the SDK as plain text.
 * @param {unknown} error
 */
export function errorOf(error) {
  if (error instanceof BrowserError) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  const message = messageOf(error);
  if (/does not belong to this thread/i.test(message)) {
    return { code: "session_forbidden", message, hint: "" };
  }
  if (/Chrome|Chromium|npm|playwright/i.test(message)) {
    return {
      code: "setup_failed",
      message,
      hint: "Needs Chrome or Chromium, plus node and npm on PATH.",
    };
  }
  if (/screenshot|JPEG/i.test(message)) {
    return {
      code: "screenshot_limit",
      message,
      hint: `Return at most ${MAX_IMAGES} JPEG screenshots per run, ${IMAGE_BYTES / 1024} KB combined.`,
    };
  }
  if (/stopped or expired|is stopped|is closed|is not running|not found/i.test(message)) {
    return { code: "session_unavailable", message, hint: REOPEN_HINT };
  }
  return { code: "command_failed", message, hint: "" };
}

/** @param {unknown} error */
export function errorBody(error) {
  const { code, message, hint } = errorOf(error);
  return { ok: false, error: { code, message, ...(hint === "" ? {} : { hint }) } };
}

/**
 * Runs out of wall-clock time first, then out of quiet time. A script that is
 * running keeps the session busy, so `lastUsed` moves when it ends.
 * @param {SessionRecord} record
 * @param {number} now
 * @returns {"ok" | "stopped" | "expired" | "idle" | "closed"}
 */
export function liveness(record, now) {
  if (record.state === "closed") return "closed";
  if (record.state !== "ready") return "stopped";
  if (now >= record.expiresAt) return "expired";
  if (now - record.lastUsed >= IDLE_TTL_MS) return "idle";
  return "ok";
}

/**
 * Marks a session that ran out of time as stopped, keeping why. The host kills
 * Chrome when this returns true.
 * @param {SessionRecord} record
 * @param {number} now
 */
export function expireRecord(record, now) {
  const state = liveness(record, now);
  if (state !== "expired" && state !== "idle") return false;
  record.state = "stopped";
  record.reason = state;
  return true;
}

/** @param {SessionRecord} record */
export function unavailable(record) {
  const why = record.state === "ready" ? "expired" : record.state;
  return new BrowserError(`session ${record.id} is ${why}; open a new session`, "session_unavailable", REOPEN_HINT);
}

/**
 * A session belongs to the thread that opened it, and no other thread can use
 * it, even with its id.
 * @param {SessionRecord} record
 * @param {string} threadId
 */
export function assertOwner(record, threadId) {
  if (record.threadId !== threadId) {
    throw new BrowserError(
      `session ${record.id} does not belong to this thread`,
      "session_forbidden",
    );
  }
}

/** @param {string} text */
export function clipText(text) {
  return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text;
}

/** @param {Array<{ bytes: number }>} images */
export function imageFailure(images) {
  if (images.length > MAX_IMAGES) {
    return `a run may take at most ${MAX_IMAGES} screenshots; it took ${images.length}`;
  }
  const total = images.reduce((sum, image) => sum + image.bytes, 0);
  if (total > IMAGE_BYTES) {
    return `the screenshots come to ${total} bytes; a run may keep ${IMAGE_BYTES}`;
  }
  return null;
}

/**
 * Width and height from a JPEG's start-of-frame marker, or null for bytes that
 * are not a JPEG.
 * @param {Pick<Uint8Array, "length"> & { [index: number]: number }} bytes
 */
export function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      const height = (bytes[at + 5] << 8) | bytes[at + 6];
      const width = (bytes[at + 7] << 8) | bytes[at + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * A path from a file: URL, decoded. QuickJS names a module with one.
 * @param {string} url
 */
export function filePath(url) {
  const text = String(url);
  const path = text.startsWith("file://") ? text.slice("file://".length) : text;
  const decoded = decodeURIComponent(path);
  // Windows file: URLs are /C:/...
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * The JSON value in one line, or null when the line is not JSON. Used where a
 * failed parse is expected: a host's error line, a log line.
 * @param {string} text
 * @returns {any}
 */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What a message from the right-sidebar page asks for. The page and this
 * dispatcher are the two ends of one small protocol, so its names live here.
 * @param {unknown} message
 */
export function panelAction(message) {
  if (message === null || typeof message !== "object") return { kind: "none" };
  const value = /** @type {Record<string, any>} */ (message);
  const type = typeof value.type === "string" ? value.type : "";
  const id = typeof value.id === "string" ? value.id : "";
  if (type === "state" || type === "refresh") return { kind: "state" };
  if (type === "open") return { kind: "open" };
  if (type === "stop" || type === "close") return { kind: type, id };
  if (type === "frame") {
    const request = Number(value.request);
    return { kind: "frame", id, request: Number.isFinite(request) ? request : 0 };
  }
  if (type === "click" || type === "wheel" || type === "type" || type === "press") {
    return {
      kind: "input",
      id,
      input: {
        kind: type,
        x: Number(value.x ?? 0),
        y: Number(value.y ?? 0),
        delta: Number(value.delta ?? 0),
        text: String(value.text ?? ""),
        key: String(value.key ?? "Enter"),
      },
    };
  }
  return { kind: "none" };
}

/**
 * The one `bash -c` line the plugin runs for a host command. Pure, so the
 * bridge's quoting is testable without Kagan.
 * @param {string} prefix shell setup, such as a PATH export
 * @param {string} host absolute path to host.mjs
 * @param {string} command
 * @param {string[]} args
 * @param {string} data the plugin's data folder
 * @param {string} [chrome] a Chrome executable the person chose
 */
export function hostCommand(prefix, host, command, args, data, chrome) {
  const argv = ["node", shellQuote(host), command, ...args.map(shellQuote), "--data", shellQuote(data)];
  if (chrome) argv.push("--chrome", shellQuote(chrome));
  return prefix + argv.join(" ");
}

/** @param {string} value */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
