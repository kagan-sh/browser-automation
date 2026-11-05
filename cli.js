// @ts-check
/**
 * The command line: flags, validation and the sentence a person reads without
 * `--json`. Shared by the plugin's CLI job and its tests.
 */
import {
  BrowserError,
  PLAYWRIGHT_VERSION,
  SCRIPT_LIMIT,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TIMEOUT_DEFAULT_MS,
} from "./core.js";

/* ------------------------------------------------------------------ *
 * Command line
 * ------------------------------------------------------------------ */

/** @typedef {{ flags: Record<string, "bool" | "value">, positionals: number, usage: string, summary: string }} CommandSpec */

/** Every command answers `--help` without treating it as a script value. */
const HELP = { "--help": "bool", "-h": "bool" };

/** @type {Record<string, CommandSpec>} */
export const COMMANDS = {
  prepare: {
    flags: { "--json": "bool", ...HELP },
    positionals: 0,
    usage: "prepare",
    summary: "Install the browser runtime if it is missing",
  },
  open: {
    flags: { "--headed": "bool", "--thread": "value", "--json": "bool", ...HELP },
    positionals: 0,
    usage: "open [--headed] [--thread <id>] [--json]",
    summary: "Open a session for this thread",
  },
  list: {
    flags: { "--thread": "value", "--json": "bool", ...HELP },
    positionals: 0,
    usage: "list [--thread <id>] [--json]",
    summary: "List this thread's sessions",
  },
  run: {
    flags: {
      "--script": "value",
      "--script-file": "value",
      "--timeout-ms": "value",
      "--timeout": "value",
      "--thread": "value",
      "--json": "bool",
      ...HELP,
    },
    positionals: 1,
    usage: "run <session-id> (--script <js> | --script-file <path>) [--timeout-ms <n>] [--json]",
    summary: "Run a trusted script in a session",
  },
  pages: {
    flags: { "--thread": "value", "--json": "bool", ...HELP },
    positionals: 1,
    usage: "pages <session-id> [--json]",
    summary: "List the session's pages",
  },
  screenshot: {
    flags: { "--page": "value", "--thread": "value", "--json": "bool", ...HELP },
    positionals: 1,
    usage: "screenshot <session-id> [--page main] [--json]",
    summary: "Save a JPEG of a page",
  },
  preview: {
    flags: { "--thread": "value", "--json": "bool", ...HELP },
    positionals: 1,
    usage: "preview <session-id> [--json]",
    summary: "Describe the panel's live frame",
  },
  stop: {
    flags: { "--thread": "value", "--json": "bool", ...HELP },
    positionals: 1,
    usage: "stop <session-id> [--json]",
    summary: "Stop Chrome, keeping the session record",
  },
  close: {
    flags: { "--thread": "value", "--json": "bool", ...HELP },
    positionals: 1,
    usage: "close <session-id> [--json]",
    summary: "Stop Chrome and clear the profile",
  },
};

export const USAGE = [
  "Usage: kg browser-automation <command> [options]",
  "",
  ...Object.values(COMMANDS).map((spec) => `  ${spec.usage}\n      ${spec.summary}`),
].join("\n");

/**
 * @param {string[]} argv
 * @returns {{ command: string, flags: Record<string, string | true>, positionals: string[] }}
 */
export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    throw new BrowserError("missing command", "unknown_command", USAGE);
  }
  const spec = COMMANDS[command];
  if (!spec) {
    throw new BrowserError(`unknown command '${command}'`, "unknown_command", USAGE);
  }
  /** @type {Record<string, string | true>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  for (let at = 0; at < rest.length; at += 1) {
    const token = rest[at];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const split = token.indexOf("=");
    const name = split === -1 ? token : token.slice(0, split);
    const kind = spec.flags[name];
    if (!kind) {
      throw new BrowserError(`unknown option '${name}'`, "invalid_option", `Usage: kg browser-automation ${spec.usage}`);
    }
    if (Object.hasOwn(flags, name)) {
      throw new BrowserError(`'${name}' was given more than once`, "invalid_option", `Usage: kg browser-automation ${spec.usage}`);
    }
    if (kind === "bool") {
      if (split !== -1) {
        throw new BrowserError(`'${name}' takes no value`, "invalid_option", `Usage: kg browser-automation ${spec.usage}`);
      }
      flags[name] = true;
      continue;
    }
    const value = split === -1 ? rest[(at += 1)] : token.slice(split + 1);
    if (value === undefined || value === "") {
      throw new BrowserError(`missing value for '${name}'`, "invalid_option", `Usage: kg browser-automation ${spec.usage}`);
    }
    flags[name] = value;
  }
  if (positionals.length > spec.positionals) {
    throw new BrowserError(
      `unexpected argument '${positionals[spec.positionals]}'`,
      "invalid_option",
      `Usage: kg browser-automation ${spec.usage}`,
    );
  }
  if (positionals.length < spec.positionals) {
    throw new BrowserError("missing session id", "invalid_option", `Usage: kg browser-automation ${spec.usage}`);
  }
  return { command, flags, positionals };
}

/**
 * @param {string | undefined} requested
 * @param {string | undefined} contextThread
 */
export function resolveThread(requested, contextThread) {
  const threadId = requested ?? contextThread;
  if (!threadId) {
    throw new BrowserError(
      "run from a thread or pass --thread <id>",
      "thread_required",
    );
  }
  if (contextThread && threadId !== contextThread) {
    throw new BrowserError(
      "a call from a thread cannot use another thread's browser session",
      "cross_thread",
    );
  }
  return threadId;
}

/**
 * `90s`, `2m`, `1500ms`. A bare number is seconds when 1-120, otherwise
 * milliseconds when 1000-120000.
 * @param {string} value
 */
export function parseDuration(value) {
  const text = String(value).trim();
  const match = /^(\d+)(ms|s|m)?$/.exec(text);
  if (!match) {
    throw new BrowserError(`invalid duration '${value}'; use 90s, 2m or 1500ms`, "invalid_timeout");
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? (amount >= TIMEOUT_MIN_MS ? "ms" : "s");
  if (unit === "ms") return amount;
  if (unit === "m") return amount * 60_000;
  return amount * 1_000;
}

/** @param {unknown} value */
export function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < TIMEOUT_MIN_MS || number > TIMEOUT_MAX_MS) {
    throw new BrowserError(
      `invalid timeout; expected an integer between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} milliseconds`,
      "invalid_timeout",
    );
  }
  return number;
}

/** @param {Record<string, string | true>} flags */
export function timeoutOf(flags) {
  const exact = flags["--timeout-ms"];
  const duration = flags["--timeout"];
  if (exact !== undefined && duration !== undefined) {
    throw new BrowserError("pass either --timeout or --timeout-ms, not both", "invalid_option");
  }
  if (exact === undefined && duration === undefined) return TIMEOUT_DEFAULT_MS;
  return boundedTimeout(duration === undefined ? exact : parseDuration(String(duration)));
}

/** @param {Record<string, string | true>} flags */
export function scriptOf(flags) {
  const script = flags["--script"];
  const scriptFile = flags["--script-file"];
  if ((script === undefined) === (scriptFile === undefined)) {
    throw new BrowserError("pass exactly one of --script or --script-file", "invalid_option");
  }
  if (typeof script === "string") {
    if (script.trim() === "") {
      throw new BrowserError("--script is empty", "invalid_option");
    }
    if (script.length > SCRIPT_LIMIT) {
      throw new BrowserError(`--script is longer than ${SCRIPT_LIMIT} characters`, "invalid_option");
    }
  }
  return {
    script: typeof script === "string" ? script : undefined,
    scriptFile: typeof scriptFile === "string" ? scriptFile : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Human output
 * ------------------------------------------------------------------ */

/** @param {any} result */
function imagesOf(result) {
  return Array.isArray(result?.images) ? result.images : [];
}

/** @param {any} result */
export function outputText(result) {
  const text = typeof result?.text === "string" ? result.text : "";
  const images = imagesOf(result)
    .map((image) => `\nimage: ${image.path} (${image.width}x${image.height})`)
    .join("");
  return `${text || "(ok)"}${images}`;
}

/**
 * The line a person sees without `--json`.
 * @param {string} command
 * @param {any} result
 */
export function humanOutput(command, result) {
  if (command === "prepare") {
    return `Browser runtime ready (playwright-core ${result?.version ?? PLAYWRIGHT_VERSION}).`;
  }
  if (command === "open") {
    const mode = result?.headless === false ? "headed" : "headless";
    return `Session ${result?.id} open (${mode} Chrome).`;
  }
  if (command === "list") {
    const sessions = Array.isArray(result) ? result : [];
    if (sessions.length === 0) return "No sessions for this thread.";
    return sessions
      .map((session) => {
        const expired = session.expiresAt <= Date.now() ? " expired" : "";
        return `${session.id}  ${session.state}${expired}  ${session.url ?? "about:blank"}`;
      })
      .join("\n");
  }
  if (command === "preview") {
    if (!result?.frame) return "No new frame.";
    const frame = result.frame;
    return `Frame ${frame.sequence} ${frame.width}x${frame.height} ${frame.url} ${frame.title}`.trim();
  }
  if (command === "stop") return `Stopped ${result?.id}.`;
  if (command === "close") return `Closed ${result?.id}.`;
  if (command === "screenshot") {
    const image = imagesOf(result)[0];
    return image ? `Screenshot saved to ${image.path}` : "(no screenshot)";
  }
  return outputText(result);
}

/** @param {string} usage */
export function commandHelp(usage) {
  return `Usage: kg browser-automation ${usage}`;
}
