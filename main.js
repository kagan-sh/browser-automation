// @ts-check

import { View } from "gpui-kit";
import { log, openPanel } from "kagan/host";
import { next, reply, fail } from "kagan/jobs";
import {
  closeSession,
  listSessions,
  openSession,
  pages,
  prepare,
  runScript,
  screenshot,
  stopSession,
} from "./sessions.js";

export { BrowserPanel } from "./panel.js";

export default class Plugin extends View {
  /** @param {import("gpui-shell").Props | undefined} _props @param {import("gpui-kit").AsyncContext} cx */
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const job = await next();
        handle(job).then(
          (value) => reply(job.id, value),
          (error) => fail(job.id, error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }

  render() {
    return "";
  }
}

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
  throw new Error(`Unknown job ${job.kind}`);
}

/**
 * @param {import("kagan/jobs").Job} job
 */
async function cli(job) {
  const argv = /** @type {string[]} */ (job.argv ?? []);
  try {
    if (job.command === "prepare") {
      const ready = await prepare();
      return { exitCode: 0, stdout: `${JSON.stringify(ready)}\n`, stderr: "" };
    }
    if (job.command === "open") {
      const headed = argv.includes("--headed");
      const threadId = flag(argv, "--thread") ?? /** @type {string|undefined} */ (job.threadId);
      const session = await openSession({ threadId, headed });
      return { exitCode: 0, stdout: `${JSON.stringify(session, null, 2)}\n`, stderr: "" };
    }
    if (job.command === "list") {
      const threadId = flag(argv, "--thread") ?? /** @type {string|undefined} */ (job.threadId);
      const sessions = await listSessions(threadId);
      return { exitCode: 0, stdout: `${JSON.stringify(sessions, null, 2)}\n`, stderr: "" };
    }
    if (job.command === "run") {
      const sessionId = argv[0];
      if (!sessionId) return usage("run <session-id> --script '…'");
      const script = flag(argv, "--script");
      if (!script) return usage("run <session-id> --script '…'");
      const timeoutMs = Number(flag(argv, "--timeout-ms") ?? "30000");
      const result = await runScript(sessionId, script, timeoutMs);
      return { exitCode: result.exitCode ?? 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
    }
    if (job.command === "pages") {
      const sessionId = argv[0];
      if (!sessionId) return usage("pages <session-id>");
      const result = await pages(sessionId);
      return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
    }
    if (job.command === "screenshot") {
      const sessionId = argv[0];
      if (!sessionId) return usage("screenshot <session-id>");
      const result = await screenshot(sessionId);
      return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: "" };
    }
    if (job.command === "stop") {
      const sessionId = argv[0];
      if (!sessionId) return usage("stop <session-id>");
      const session = await stopSession(sessionId);
      return { exitCode: 0, stdout: `${JSON.stringify(session, null, 2)}\n`, stderr: "" };
    }
    if (job.command === "close") {
      const sessionId = argv[0];
      if (!sessionId) return usage("close <session-id>");
      const session = await closeSession(sessionId);
      return { exitCode: 0, stdout: `${JSON.stringify(session, null, 2)}\n`, stderr: "" };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Usage: kg browser-automation <prepare|open|list|run|pages|screenshot|stop|close>\n",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", message);
    return { exitCode: 1, stdout: "", stderr: `${message}\n` };
  }
}

/**
 * @param {import("kagan/jobs").Job} job
 */
async function tool(job) {
  const input = /** @type {Record<string, unknown>} */ (job.input ?? {});
  try {
    if (job.name === "browser_open") {
      await prepare();
      const session = await openSession({
        threadId: /** @type {string|undefined} */ (job.threadId),
        headed: Boolean(input.headed),
      });
      return {
        text: `Opened session ${session.id} (local ${session.headless ? "headless" : "headed"} Chrome).\nKeep this id for run / screenshot / close.`,
      };
    }
    if (job.name === "browser_run") {
      const sessionId = String(input.sessionId ?? "");
      const script = String(input.script ?? "");
      if (!sessionId || !script) return { text: "sessionId and script are required", isError: true };
      const result = await runScript(sessionId, script, Number(input.timeoutMs ?? 30_000));
      const images = Array.isArray(result.images)
        ? result.images.map((image) => `\nimage: ${image.path}`).join("")
        : "";
      return { text: `${result.text || "(ok)"}${images}` };
    }
    if (job.name === "browser_screenshot") {
      const sessionId = String(input.sessionId ?? "");
      if (!sessionId) return { text: "sessionId is required", isError: true };
      const result = await screenshot(sessionId);
      return { text: `Screenshot saved to ${result.text}` };
    }
    if (job.name === "browser_pages") {
      const sessionId = String(input.sessionId ?? "");
      if (!sessionId) return { text: "sessionId is required", isError: true };
      const result = await pages(sessionId);
      return { text: result.text || "[]" };
    }
    if (job.name === "browser_list") {
      const sessions = await listSessions(/** @type {string|undefined} */ (job.threadId));
      return { text: JSON.stringify(sessions, null, 2) };
    }
    if (job.name === "browser_close") {
      const sessionId = String(input.sessionId ?? "");
      if (!sessionId) return { text: "sessionId is required", isError: true };
      await closeSession(sessionId);
      return { text: `Closed ${sessionId}` };
    }
    if (job.name === "browser_stop") {
      const sessionId = String(input.sessionId ?? "");
      if (!sessionId) return { text: "sessionId is required", isError: true };
      await stopSession(sessionId);
      return { text: `Stopped ${sessionId}` };
    }
    return { text: `Unknown tool ${job.name}`, isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: message, isError: true };
  }
}

/** @param {string[]} argv @param {string} name */
function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

/** @param {string} text */
function usage(text) {
  return { exitCode: 1, stdout: "", stderr: `Usage: kg browser-automation ${text}\n` };
}

