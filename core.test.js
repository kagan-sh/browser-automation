import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMANDS, commandHelp, parseCommand } from "./cli.js";
import { distance, formatSnapshot, formatView, resolveThread, whole } from "./core.js";

const manifest = JSON.parse(readFileSync(new URL("./kagan.json", import.meta.url), "utf8"));

test("the manifest has no panel and asks for the browser area", () => {
  assert.equal(manifest.ui, undefined);
  assert.equal(manifest.commands, undefined);
  assert.equal(manifest.events, undefined);
  assert.equal(manifest.settings, undefined);
  assert.deepEqual(manifest.powers, { areas: ["browser"] });
  const text = JSON.stringify(manifest);
  assert.equal(text.includes('"panels"'), false);
  assert.equal(text.includes('"title"'), false);
  assert.equal(text.includes("playwright"), false);
  assert.equal(text.includes("screenshot"), false);
  assert.equal(text.includes("evaluate"), false);
  const verbs = [
    "open",
    "status",
    "snapshot",
    "goto",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "select",
    "scroll",
    "close",
  ];
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name),
    verbs.map((verb) => `browser_${verb}`),
  );
  assert.deepEqual(
    manifest.cli[0].commands.map((command) => command.name),
    verbs,
  );
  for (const command of manifest.cli[0].commands) {
    assert.equal(command.usage, COMMANDS[command.name].usage);
  }
});

test("fill is text, and a ref is a whole number", () => {
  const fill = JSON.parse(readFileSync(new URL("./schemas/browser_fill.json", import.meta.url), "utf8"));
  assert.equal(fill.additionalProperties, false);
  assert.equal(fill.properties.text.type, "string");
  assert.equal(fill.properties.file, undefined);
  assert.deepEqual(Object.keys(fill.properties).sort(), ["ref", "text"]);
  assert.equal(whole(2), 2);
  assert.equal(whole("2"), 2);
  assert.equal(whole(0), 0);
  assert.equal(whole(4294967295), 4294967295);
  assert.throws(() => whole(1.5), /whole number/);
  assert.throws(() => whole(-1), /whole number/);
  assert.throws(() => whole("1.5"), /whole number/);
  assert.throws(() => whole("e12"), /whole number/);
  assert.throws(() => whole(4294967296), /whole number/);
  assert.equal(distance("-200"), -200);
  assert.throws(() => distance("nope"), /number/);
});

test("every command parses, and --file is not a way to fill", () => {
  assert.equal(parseCommand("open", ["https://example.com", "--json"]).flags["--json"], true);
  assert.deepEqual(parseCommand("click", ["4"]).positionals, ["4"]);
  assert.deepEqual(parseCommand("fill", ["2", "ada@example.com"]).positionals, ["2", "ada@example.com"]);
  assert.deepEqual(parseCommand("scroll", ["-200"]).positionals, ["-200"]);
  assert.deepEqual(parseCommand("fill", ["2", "--", "--hello"]).positionals, ["2", "--hello"]);
  assert.equal(parseCommand("open", ["--help"]).flags["--help"], true);
  assert.throws(() => parseCommand("fill", ["2", "--file", "note.txt"]), /unknown option '--file'/);
  assert.throws(() => parseCommand("open", []), /missing url/);
  assert.throws(() => parseCommand("click", []), /missing ref/);
  assert.throws(() => parseCommand("fill", ["2"]), /missing text/);
  assert.throws(() => parseCommand("browse", []), /unknown command 'browse'/);
  assert.throws(() => parseCommand("status", ["extra"]), /unexpected argument 'extra'/);
  for (const command of Object.keys(COMMANDS)) {
    const positionals = Array.from({ length: COMMANDS[command].positionals }, () => "x");
    assert.doesNotThrow(() => parseCommand(command, positionals), command);
    assert.ok(commandHelp(command).includes(COMMANDS[command].usage), command);
  }
});

test("a thread call cannot name another thread", () => {
  assert.equal(resolveThread(undefined, "thr_1"), "thr_1");
  assert.equal(resolveThread("thr_2", undefined), "thr_2");
  assert.throws(() => resolveThread(undefined, undefined), /pass --thread/);
  assert.throws(() => resolveThread("thr_2", "thr_1"), /another thread/);
});

test("a snapshot prints whole-number refs and the page text", () => {
  const text = formatSnapshot({
    url: "https://example.com/login",
    title: "Sign in",
    controls: [
      { ref: 2, role: "textbox", name: "Email", value: "ada@example.com", focused: false, disabled: false },
      { ref: 3, role: "button", name: "Sign in", focused: true, disabled: false },
    ],
    text: "Welcome",
    truncated: false,
  });
  assert.equal(
    text,
    [
      "https://example.com/login",
      "Sign in",
      '[2] textbox "Email" value="ada@example.com"',
      '[3] button "Sign in" focused',
      "text:",
      "Welcome",
    ].join("\n"),
  );
  assert.match(formatView({ url: "https://example.com/", title: "Example", shown: true }), /Browser tab is showing it/);
  assert.match(formatView({ url: "https://example.com/", title: "", shown: false }), /hidden until this thread/);
});
