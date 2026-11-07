// @ts-check
/**
 * `kg browser-automation <verb>`. The verbs are the host's. `--file` is not one
 * of them: fill's words are the text.
 */
import { BrowserError, formatSnapshot, formatView } from "./core.js";

/** @typedef {{ flags: Record<string, "bool" | "value">, positionals: number, missing: string[], usage: string, summary: string }} CommandSpec */

const HELP = { "--help": "bool", "-h": "bool" };
const THREAD = { "--thread": "value", "--json": "bool", ...HELP };

/** @type {Record<string, CommandSpec>} */
export const COMMANDS = {
  open: {
    flags: { ...THREAD },
    positionals: 1,
    missing: ["missing url"],
    usage: "open <url> [--thread <id>] [--json]",
    summary: "Open the built-in Browser tab on an address",
  },
  status: {
    flags: { ...THREAD },
    positionals: 0,
    missing: [],
    usage: "status [--thread <id>] [--json]",
    summary: "Read the page this thread is driving",
  },
  snapshot: {
    flags: { ...THREAD },
    positionals: 0,
    missing: [],
    usage: "snapshot [--thread <id>] [--json]",
    summary: "Read the page, including whole-number refs",
  },
  goto: {
    flags: { ...THREAD },
    positionals: 1,
    missing: ["missing url"],
    usage: "goto <url> [--thread <id>] [--json]",
    summary: "Load another address in the open page",
  },
  back: {
    flags: { ...THREAD },
    positionals: 0,
    missing: [],
    usage: "back [--thread <id>] [--json]",
    summary: "Go back",
  },
  forward: {
    flags: { ...THREAD },
    positionals: 0,
    missing: [],
    usage: "forward [--thread <id>] [--json]",
    summary: "Go forward",
  },
  reload: {
    flags: { ...THREAD },
    positionals: 0,
    missing: [],
    usage: "reload [--thread <id>] [--json]",
    summary: "Reload the page",
  },
  click: {
    flags: { ...THREAD },
    positionals: 1,
    missing: ["missing ref"],
    usage: "click <ref> [--thread <id>] [--json]",
    summary: "Click a whole-number ref from the latest snapshot",
  },
  fill: {
    flags: { ...THREAD },
    positionals: 2,
    missing: ["missing ref", "missing text"],
    usage: "fill <ref> <text> [--thread <id>] [--json]",
    summary: "Write text into a control. The text is the argument, not a file",
  },
  type: {
    flags: { ...THREAD },
    positionals: 1,
    missing: ["missing text"],
    usage: "type <text> [--thread <id>] [--json]",
    summary: "Type text into the focused control",
  },
  press: {
    flags: { ...THREAD },
    positionals: 1,
    missing: ["missing key"],
    usage: "press <key> [--thread <id>] [--json]",
    summary: "Press a key in the focused control",
  },
  select: {
    flags: { ...THREAD },
    positionals: 2,
    missing: ["missing ref", "missing option"],
    usage: "select <ref> <option> [--thread <id>] [--json]",
    summary: "Choose an option in a select, by value or label",
  },
  scroll: {
    flags: { ...THREAD },
    positionals: 1,
    missing: ["missing distance"],
    usage: "scroll <dy> [--thread <id>] [--json]",
    summary: "Scroll by dy pixels. Positive is down",
  },
  close: {
    flags: { ...THREAD },
    positionals: 0,
    missing: [],
    usage: "close [--thread <id>] [--json]",
    summary: "Stop driving the page and leave it open",
  },
};

export const USAGE = [
  "Usage: kg browser-automation <command> [options]",
  "",
  "Drives the built-in Browser tab. One http or https page per window.",
  "",
  ...Object.values(COMMANDS).map((spec) => `  ${spec.usage}\n      ${spec.summary}`),
].join("\n");

const NEGATIVE = /^-\d+(\.\d+)?$/;

/**
 * @param {string} command
 * @param {string[]} argv
 * @returns {{ command: string, flags: Record<string, string | true>, positionals: string[] }}
 */
export function parseCommand(command, argv) {
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
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (token === "--") {
      positionals.push(...argv.slice(at + 1));
      break;
    }
    if (!token.startsWith("-") || NEGATIVE.test(token)) {
      positionals.push(token);
      continue;
    }
    const split = token.indexOf("=");
    const name = split === -1 ? token : token.slice(0, split);
    const kind = spec.flags[name];
    if (!kind) {
      throw new BrowserError(
        `unknown option '${name}'`,
        "invalid_option",
        `Usage: kg browser-automation ${spec.usage}`,
      );
    }
    if (Object.hasOwn(flags, name)) {
      throw new BrowserError(
        `'${name}' was given more than once`,
        "invalid_option",
        `Usage: kg browser-automation ${spec.usage}`,
      );
    }
    if (kind === "bool") {
      if (split !== -1) {
        throw new BrowserError(
          `'${name}' takes no value`,
          "invalid_option",
          `Usage: kg browser-automation ${spec.usage}`,
        );
      }
      flags[name] = true;
      continue;
    }
    const value = split === -1 ? argv[(at += 1)] : token.slice(split + 1);
    if (value === undefined || value === "") {
      throw new BrowserError(
        `missing value for '${name}'`,
        "invalid_option",
        `Usage: kg browser-automation ${spec.usage}`,
      );
    }
    flags[name] = value;
  }
  if (flags["--help"] || flags["-h"]) {
    return { command, flags, positionals };
  }
  if (positionals.length > spec.positionals) {
    throw new BrowserError(
      `unexpected argument '${positionals[spec.positionals]}'`,
      "invalid_option",
      `Usage: kg browser-automation ${spec.usage}`,
    );
  }
  if (positionals.length < spec.positionals) {
    throw new BrowserError(
      spec.missing[positionals.length] ?? "missing argument",
      "invalid_option",
      `Usage: kg browser-automation ${spec.usage}`,
    );
  }
  return { command, flags, positionals };
}

/** @param {string} command */
export function commandHelp(command) {
  const spec = COMMANDS[command];
  if (!spec) return USAGE;
  return [`Usage: kg browser-automation ${spec.usage}`, "", spec.summary].join("\n");
}

/**
 * The line a person sees without `--json`.
 * @param {string} command
 * @param {any} result
 * @param {any[]} args
 */
export function humanOutput(command, result, args) {
  if (command === "open") return `Opened ${formatView(result)}`;
  if (command === "status") return formatView(result);
  if (command === "snapshot") return formatSnapshot(result);
  if (command === "goto") return `Loaded ${args[0]}.`;
  if (command === "click") return `Clicked ${args[0]}.`;
  if (command === "fill") return `Filled ${args[0]}.`;
  if (command === "type") return "Typed.";
  if (command === "press") return `Pressed ${args[0]}.`;
  if (command === "select") return `Selected ${args[1]}.`;
  if (command === "scroll") return `Scrolled ${args[0]}.`;
  if (command === "back") return "Went back.";
  if (command === "forward") return "Went forward.";
  if (command === "reload") return "Reloaded.";
  if (command === "close") return "Stopped driving the page. It stays open.";
  return "Done.";
}
