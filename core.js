// @ts-check
/**
 * Checks the plugin shares with the host: a ref is a whole number, fill is
 * text, and each call names a thread. The host still decides what a page can do.
 */

export class BrowserError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {string} [hint]
   */
  constructor(message, code = "browser_failed", hint = "") {
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

/** @param {unknown} error */
export function errorBody(error) {
  if (error instanceof BrowserError) {
    return { ok: false, error: { code: error.code, message: error.message, hint: error.hint } };
  }
  return { ok: false, error: { code: "browser_failed", message: messageOf(error), hint: "" } };
}

const REF_HINT = "A ref is a whole number from the latest snapshot.";

/**
 * A ref the host will accept: a whole number in the u32 range.
 * @param {unknown} value
 */
export function whole(value) {
  let number = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      throw new BrowserError("ref must be a whole number", "invalid_ref", REF_HINT);
    }
    number = Number(text);
  }
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > 0xffff_ffff) {
    throw new BrowserError("ref must be a whole number", "invalid_ref", REF_HINT);
  }
  return number;
}

/**
 * Scroll distance in pixels. Positive is down.
 * @param {unknown} value
 */
export function distance(value) {
  let number = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") {
      throw new BrowserError("scroll must be a number", "invalid_option");
    }
    number = Number(text);
  }
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new BrowserError("scroll must be a number", "invalid_option");
  }
  return number;
}

/**
 * The address string the host will interpret. Empty is refused here; http,
 * https, a bare name, and a local host are the host's decision.
 * @param {unknown} value
 */
export function address(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrowserError("type a web address, such as example.com", "invalid_option");
  }
  return value.trim();
}

/**
 * Fill and type take text. A file path is not read.
 * @param {unknown} value
 * @param {string} [name]
 */
export function text(value, name = "text") {
  if (typeof value !== "string") {
    throw new BrowserError(`${name} must be text`, "invalid_option");
  }
  return value;
}

/** @param {unknown} value */
export function typed(value) {
  const body = text(value);
  if (body === "") {
    throw new BrowserError("text must not be empty", "invalid_option");
  }
  return body;
}

/** @param {unknown} value */
export function keyName(value) {
  if (typeof value !== "string" || value === "") {
    throw new BrowserError("key must not be empty", "invalid_option");
  }
  return value;
}

/**
 * @param {string | undefined} requested
 * @param {string | undefined} contextThread
 */
export function resolveThread(requested, contextThread) {
  const threadId = requested ?? contextThread;
  if (!threadId) {
    throw new BrowserError("run from a thread or pass --thread <id>", "thread_required");
  }
  if (contextThread && threadId !== contextThread) {
    throw new BrowserError(
      "a call from a thread cannot name another thread",
      "cross_thread",
    );
  }
  return threadId;
}

/**
 * @param {{ url?: string, title?: string, shown?: boolean }} view
 */
export function formatView(view) {
  const title = view.title ? ` — ${view.title}` : "";
  const where = view.shown
    ? "The Browser tab is showing it."
    : "The page is hidden until this thread is on screen.";
  return `${view.url ?? ""}${title}. ${where}`;
}

/**
 * @param {{ url?: string, title?: string, controls?: Array<Record<string, any>>, text?: string, truncated?: boolean }} snapshot
 */
export function formatSnapshot(snapshot) {
  /** @type {string[]} */
  const lines = [snapshot.url ?? ""];
  if (snapshot.title) lines.push(snapshot.title);
  for (const control of snapshot.controls ?? []) {
    let line = `[${control.ref}] ${control.role} ${JSON.stringify(control.name ?? "")}`;
    if (control.value !== undefined) line += ` value=${JSON.stringify(control.value)}`;
    if (control.disabled) line += " disabled";
    if (control.focused) line += " focused";
    if (control.checked === true) line += " checked";
    if (control.checked === false) line += " unchecked";
    lines.push(line);
  }
  if (snapshot.text) {
    lines.push("text:", snapshot.text);
  }
  if (snapshot.truncated) lines.push("truncated");
  return lines.join("\n");
}
