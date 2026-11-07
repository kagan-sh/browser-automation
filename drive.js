// @ts-check
/**
 * Tool and CLI jobs. Every verb is one call to `kagan/browser`, with the thread
 * named on the call. Fill passes the text through; nothing reads a file.
 */
import * as browser from "./browser.js";
import { commandHelp, humanOutput, parseCommand, USAGE } from "./cli.js";
import {
  BrowserError,
  address,
  distance,
  errorBody,
  keyName,
  messageOf,
  resolveThread,
  text,
  typed,
  whole,
} from "./core.js";

/**
 * @param {string} verb
 * @param {string} threadId
 * @param {any[]} args
 */
function invoke(verb, threadId, args) {
  switch (verb) {
    case "open":
      return browser.open(threadId, args[0]);
    case "status":
      return browser.status(threadId);
    case "snapshot":
      return browser.snapshot(threadId);
    case "goto":
      return browser.goto(threadId, args[0]);
    case "back":
      return browser.back(threadId);
    case "forward":
      return browser.forward(threadId);
    case "reload":
      return browser.reload(threadId);
    case "click":
      return browser.click(threadId, args[0]);
    case "fill":
      return browser.fill(threadId, args[0], args[1]);
    case "type":
      return browser.type(threadId, args[0]);
    case "press":
      return browser.press(threadId, args[0]);
    case "select":
      return browser.select(threadId, args[0], args[1]);
    case "scroll":
      return browser.scroll(threadId, args[0]);
    case "close":
      return browser.close(threadId);
    default:
      throw new BrowserError(`unknown command '${verb}'`, "unknown_command");
  }
}

/** @type {Record<string, { verb: string, args: (input: any) => any[] }>} */
const TOOLS = {
  browser_open: { verb: "open", args: (input) => [address(input.url)] },
  browser_status: { verb: "status", args: () => [] },
  browser_snapshot: { verb: "snapshot", args: () => [] },
  browser_goto: { verb: "goto", args: (input) => [address(input.url)] },
  browser_back: { verb: "back", args: () => [] },
  browser_forward: { verb: "forward", args: () => [] },
  browser_reload: { verb: "reload", args: () => [] },
  browser_click: { verb: "click", args: (input) => [whole(input.ref)] },
  browser_fill: { verb: "fill", args: (input) => [whole(input.ref), text(input.text)] },
  browser_type: { verb: "type", args: (input) => [typed(input.text)] },
  browser_press: { verb: "press", args: (input) => [keyName(input.key)] },
  browser_select: { verb: "select", args: (input) => [whole(input.ref), text(input.option, "option")] },
  browser_scroll: { verb: "scroll", args: (input) => [distance(input.dy)] },
  browser_close: { verb: "close", args: () => [] },
};

/**
 * @param {string} command
 * @param {string[]} positionals
 */
function cliArgs(command, positionals) {
  if (command === "open" || command === "goto") return [address(positionals[0])];
  if (command === "click") return [whole(positionals[0])];
  if (command === "fill") return [whole(positionals[0]), text(positionals[1])];
  if (command === "type") return [typed(positionals[0])];
  if (command === "press") return [keyName(positionals[0])];
  if (command === "select") return [whole(positionals[0]), text(positionals[1], "option")];
  if (command === "scroll") return [distance(positionals[0])];
  return [];
}

/**
 * @param {import("kagan/jobs").Job} job
 */
export async function handle(job) {
  if (job.kind === "tool") return tool(job);
  if (job.kind === "cli") return cli(job);
  throw new Error(`Unknown job ${job.kind}`);
}

/**
 * @param {import("kagan/jobs").Job} job
 */
async function tool(job) {
  const spec = TOOLS[job.name ?? ""];
  if (!spec) return { text: `Unknown tool ${job.name}`, isError: true };
  try {
    const threadId = resolveThread(undefined, typeof job.threadId === "string" ? job.threadId : undefined);
    const input = /** @type {Record<string, unknown>} */ (job.input ?? {});
    const args = spec.args(input);
    const value = await invoke(spec.verb, threadId, args);
    return { text: humanOutput(spec.verb, value, args) };
  } catch (error) {
    return { text: messageOf(error), isError: true };
  }
}

/**
 * @param {import("kagan/jobs").Job} job
 */
async function cli(job) {
  const argv = /** @type {string[]} */ (job.argv ?? []);
  const json = argv.includes("--json");
  try {
    const command = typeof job.command === "string" ? job.command : "";
    if (!command || command === "--help" || command === "-h") {
      return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
    }
    const parsed = parseCommand(command, argv);
    if (parsed.flags["--help"] || parsed.flags["-h"]) {
      return { exitCode: 0, stdout: `${commandHelp(command)}\n`, stderr: "" };
    }
    const requested = typeof parsed.flags["--thread"] === "string" ? parsed.flags["--thread"] : undefined;
    const threadId = resolveThread(requested, typeof job.threadId === "string" ? job.threadId : undefined);
    const args = cliArgs(command, parsed.positionals);
    const value = await invoke(command, threadId, args);
    const body = value === undefined ? { ok: true } : value;
    const stdout = json ? `${JSON.stringify(body, null, 2)}\n` : `${humanOutput(command, body, args)}\n`;
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const body = errorBody(error);
    const hint = body.error.hint ? `\n${body.error.hint}` : "";
    return {
      exitCode: 1,
      stdout: json ? `${JSON.stringify(body)}\n` : "",
      stderr: `${body.error.message}${hint}\n`,
    };
  }
}
