// @ts-check
/**
 * One plugin: the job loop, the CLI, the agent tools, and the messages the
 * right-sidebar browser page sends and receives.
 */
import { View } from "gpui-kit";
import { context, log, openPanel, threadOnScreen } from "kagan/host";
import { next, reply, fail } from "kagan/jobs";
import { post } from "kagan/panel";
import { errorBody, messageOf, panelAction } from "./core.js";
import {
  COMMANDS,
  USAGE,
  boundedTimeout,
  commandHelp,
  humanOutput,
  outputText,
  parseCommand,
  resolveThread,
  scriptOf,
  timeoutOf,
} from "./cli.js";
import {
  closeSession,
  input,
  listSessions,
  openSession,
  pages,
  prepare,
  preview,
  runScript,
  runScriptFile,
  screenshot,
  stopSession,
} from "./sessions.js";

export default class Plugin extends View {
  /** @param {import("gpui-shell").Props | undefined} _props @param {import("gpui-kit").AsyncContext} cx */
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const job = await next();
        handle(job).then(
          (value) => reply(job.id, value),
          (error) => fail(job.id, messageOf(error)),
        );
      }
    });
  }

  render() {
    return "";
  }
}

/** @type {Set<string>} */
const busyPanels = new Set();

/**
 * @param {import("kagan/jobs").Job} job
 */
async function handle(job) {
  if (job.kind === "command") {
    if (job.command === "show") {
      await openPanel("sessions");
      return null;
    }
    throw new Error(`Unknown command ${job.command}`);
  }
  if (job.kind === "cli") return cli(job);
  if (job.kind === "tool") return tool(job);
  if (job.kind === "page") return panelMessage(job);
  if (job.kind === "event") return onEvent(job);
  throw new Error(`Unknown job ${job.kind}`);
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * @param {import("kagan/jobs").Job} job
 */
async function cli(job) {
  const argv = /** @type {string[]} */ (job.argv ?? []);
  const json = argv.includes("--json");
  try {
    const first = argv[0];
    if (!first || first === "--help" || first === "-h") {
      return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
    }
    const { command, flags, positionals } = parseCommand(argv);
    if (flags["--help"] || flags["-h"]) {
      return { exitCode: 0, stdout: `${helpFor(command)}\n`, stderr: "" };
    }
    const requested = typeof flags["--thread"] === "string" ? flags["--thread"] : undefined;
    const threadId = command === "prepare" ? "" : resolveThread(requested, job.threadId);
    const result = await perform(command, flags, positionals, threadId, job.cwd);
    const stdout = json ? `${JSON.stringify(result, null, 2)}\n` : `${humanOutput(command, result)}\n`;
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    log("warn", messageOf(error));
    const body = errorBody(error);
    const hint = body.error.hint ? `\n${body.error.hint}` : "";
    return {
      exitCode: 1,
      stdout: json ? `${JSON.stringify(body)}\n` : "",
      stderr: `${body.error.message}${hint}\n`,
    };
  }
}

/** @param {string} command */
function helpFor(command) {
  const spec = COMMANDS[command];
  return spec ? commandHelp(spec.usage) : USAGE;
}

/**
 * @param {string} command
 * @param {Record<string, string | true>} flags
 * @param {string[]} positionals
 * @param {string} threadId
 * @param {string} [cwd]
 */
async function perform(command, flags, positionals, threadId, cwd) {
  const sessionId = positionals[0] ?? "";
  if (command === "prepare") return prepare();
  if (command === "open") {
    const session = await openSession(threadId, flags["--headed"] === true);
    await reveal(threadId);
    return session;
  }
  if (command === "list") return listSessions(threadId);
  if (command === "run") {
    const { script, scriptFile } = scriptOf(flags);
    const timeoutMs = timeoutOf(flags);
    if (scriptFile !== undefined) {
      return runScriptFile(threadId, sessionId, scriptFile, cwd ?? ".", timeoutMs);
    }
    return runScript(threadId, sessionId, String(script), timeoutMs);
  }
  if (command === "pages") return pages(threadId, sessionId);
  if (command === "screenshot") {
    const page = typeof flags["--page"] === "string" ? flags["--page"] : "main";
    return screenshot(threadId, sessionId, page);
  }
  if (command === "preview") {
    const { frame } = await preview(threadId, sessionId);
    if (!frame) return { frame: null };
    const { data, ...rest } = frame;
    void data;
    return { frame: rest };
  }
  if (command === "stop") return stopSession(threadId, sessionId);
  if (command === "close") return closeSession(threadId, sessionId);
  throw new Error(`Unknown command ${command}`);
}

/** @param {string} threadId */
async function reveal(threadId) {
  if (!threadOnScreen(threadId)) return;
  await openPanel("sessions").catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

/**
 * @param {import("kagan/jobs").Job} job
 */
async function tool(job) {
  const threadId = typeof job.threadId === "string" ? job.threadId : "";
  if (!threadId) return { text: "Open a thread first; browser sessions belong to a thread.", isError: true };
  const input = /** @type {Record<string, unknown>} */ (job.input ?? {});
  const sessionId = String(input.sessionId ?? "");
  try {
    if (job.name === "browser_open") {
      await prepare();
      const session = await openSession(threadId, Boolean(input.headed));
      await reveal(threadId);
      return {
        text: `Opened session ${session.id} (${session.headless ? "headless" : "headed"} Chrome).\nKeep this id for browser_run, browser_screenshot and browser_close. The right sidebar shows it live.`,
      };
    }
    if (job.name === "browser_run") {
      const script = String(input.script ?? "");
      if (!sessionId || script === "") {
        return { text: "sessionId and script are required", isError: true };
      }
      const timeoutMs = boundedTimeout(input.timeoutMs ?? 30_000);
      return { text: outputText(await runScript(threadId, sessionId, script, timeoutMs)) };
    }
    if (job.name === "browser_screenshot") {
      if (!sessionId) return { text: "sessionId is required", isError: true };
      const result = await screenshot(threadId, sessionId);
      return { text: `Screenshot saved to ${result.text}` };
    }
    if (job.name === "browser_pages") {
      if (!sessionId) return { text: "sessionId is required", isError: true };
      return { text: (await pages(threadId, sessionId)).text || "[]" };
    }
    if (job.name === "browser_list") {
      return { text: JSON.stringify(await listSessions(threadId), null, 2) };
    }
    if (job.name === "browser_stop") {
      if (!sessionId) return { text: "sessionId is required", isError: true };
      await stopSession(threadId, sessionId);
      return { text: `Stopped ${sessionId}` };
    }
    if (job.name === "browser_close") {
      if (!sessionId) return { text: "sessionId is required", isError: true };
      await closeSession(threadId, sessionId);
      return { text: `Closed ${sessionId}` };
    }
    return { text: `Unknown tool ${job.name}`, isError: true };
  } catch (error) {
    const { message } = errorBody(error).error;
    return { text: message, isError: true };
  }
}

/* ------------------------------------------------------------------ *
 * The right-sidebar page
 * ------------------------------------------------------------------ */

/**
 * @param {import("kagan/jobs").Job} job
 */
async function panelMessage(job) {
  const panelId = /** @type {string} */ (job.panelId);
  const action = panelAction(job.message);
  const threadId = context().threadId ?? "";
  try {
    if (action.kind === "state") {
      await sendState(panelId, threadId);
      return null;
    }
    if (action.kind === "open") {
      if (!threadId) throw new Error("Open a thread first.");
      await prepare();
      const session = await openSession(threadId, false);
      await sendState(panelId, threadId);
      await post(panelId, { type: "selected", id: session.id });
      return null;
    }
    if (action.kind === "stop" || action.kind === "close") {
      if (action.id && threadId) {
        if (action.kind === "stop") await stopSession(threadId, action.id);
        else await closeSession(threadId, action.id);
      }
      await sendState(panelId, threadId);
      return null;
    }
    if (action.kind === "frame") {
      await sendFrame(panelId, threadId, action.id, action.request);
      return null;
    }
    if (action.kind === "input") {
      await forwardInput(threadId, action.id, action.input);
      return null;
    }
    return null;
  } catch (error) {
    await post(panelId, { type: "failed", message: messageOf(error) }).catch(() => undefined);
    return null;
  }
}

/**
 * @param {string} panelId
 * @param {string} threadId
 */
async function sendState(panelId, threadId) {
  if (!threadId) {
    await post(panelId, { type: "state", threadId: "", sessions: [] });
    return;
  }
  const sessions = await listSessions(threadId);
  await post(panelId, {
    type: "state",
    threadId,
    sessions: sessions.map((session) => ({
      id: session.id,
      state: session.state,
      url: session.url ?? "about:blank",
      title: session.title ?? "",
      headless: session.headless,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    })),
  });
}

/**
 * The panel is a view of the page, so a click or a keystroke there becomes one
 * at the same place in Chrome.
 * @param {string} threadId
 * @param {string} sessionId
 * @param {{ kind: import("./core.js").InputKind, x: number, y: number, delta: number, text: string, key: string }} action
 */
async function forwardInput(threadId, sessionId, action) {
  if (!threadId || !sessionId) return;
  await input(threadId, sessionId, action);
}

/**
 * One frame at a time per panel: the page asks again when it has the last one.
 * @param {string} panelId
 * @param {string} threadId
 * @param {string} sessionId
 * @param {number} request
 */
async function sendFrame(panelId, threadId, sessionId, request) {
  if (!threadId || !sessionId) {
    await post(panelId, { type: "frame", request, failed: true });
    return;
  }
  const key = `${panelId}:${sessionId}`;
  if (busyPanels.has(key)) return;
  busyPanels.add(key);
  try {
    const { frame } = await preview(threadId, sessionId);
    if (!frame) await post(panelId, { type: "frame", request, failed: true });
    else await post(panelId, { type: "frame", request, ...frame });
  } catch (error) {
    await post(panelId, { type: "frame", request, failed: true, message: messageOf(error) }).catch(
      () => undefined,
    );
  } finally {
    busyPanels.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/**
 * Archiving or deleting a thread closes what it opened, so Chrome does not
 * outlive the work.
 * @param {import("kagan/jobs").Job} job
 */
async function onEvent(job) {
  if (job.type !== "thread.archived" && job.type !== "thread.deleted") return null;
  const threadId = typeof job.threadId === "string" ? job.threadId : "";
  if (!threadId) return null;
  const sessions = await listSessions(threadId);
  await Promise.allSettled(
    sessions
      .filter((session) => session.state === "ready")
      .map((session) => closeSession(threadId, session.id)),
  );
  return null;
}
