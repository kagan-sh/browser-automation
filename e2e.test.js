// End to end: real Chrome, the real host, the real script sandbox.
// `npm run test:e2e`, or KG_E2E=1 node --test e2e.test.js. A machine without
// Chrome or npm skips instead of failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { jpegSize } from "./core.js";

const run = promisify(execFile);
const HOST = join(dirname(fileURLToPath(import.meta.url)), "host.mjs");
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path) => existsSync(path));

const skip = process.env.KG_E2E ? false : "set KG_E2E=1 to drive real Chrome";
const needsChrome = CHROME ? false : "no Chrome or Chromium on this machine";

/**
 * @param {string} data
 * @param {string[]} argv
 */
async function host(data, argv) {
  try {
    const result = await run(process.execPath, [HOST, ...argv, "--data", data], { timeout: 180_000 });
    return { code: 0, stdout: result.stdout.trim() };
  } catch (error) {
    const failed = /** @type {{ code?: number, stdout?: string, stderr?: string }} */ (error);
    return { code: failed.code ?? 1, stdout: "", stderr: failed.stderr ?? "" };
  }
}

test("a session browses, snapshots, clicks, fills, captures and closes", {
  timeout: 300_000,
  skip: skip || needsChrome,
}, async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-e2e-"));
  const page = join(data, "fixture.html");
  writeFileSync(
    page,
    `<!doctype html><html><head><title>kg fixture</title></head>
     <body><h1>Fixture</h1><a href="#done">A link</a>
     <input id="email" aria-label="Email" />
     <button onclick="document.title='clicked'">Sign in</button>
     <script>document.addEventListener("keydown", (event) => { document.title = "key:" + event.key; });</script>
     </body></html>`,
  );
  try {
    assert.equal((await host(data, ["prepare"])).code, 0);

    const opened = await host(data, ["open", "--thread", "thread-1"]);
    assert.equal(opened.code, 0, opened.stderr);
    const session = JSON.parse(opened.stdout);
    assert.equal(session.state, "ready");
    assert.equal(session.headless, true);
    const id = session.id;
    assert.ok(readFileSync(join(data, "sessions", "thread-1", id, "session.json"), "utf8").includes(id));

    const browsed = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      `const p = await browser.getPage("main");
       await p.goto(${JSON.stringify(`file://${page}`)});
       return await p.title();`,
    ]);
    assert.equal(browsed.code, 0, browsed.stderr);
    assert.equal(JSON.parse(browsed.stdout).text, "kg fixture");

    const snapshot = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      `const p = await browser.getPage("main"); return await p.snapshot();`,
    ]);
    assert.equal(snapshot.code, 0, snapshot.stderr);
    assert.match(JSON.parse(snapshot.stdout).text, /Sign in/);

    const clicked = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      `const p = await browser.getPage("main");
       await p.click("text=Sign in");
       await p.fill("#email", "agent@example.com");
       return { title: await p.title(), email: await p.locator("#email").inputValue() };`,
    ]);
    assert.equal(clicked.code, 0, clicked.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(clicked.stdout).text), {
      title: "clicked",
      email: "agent@example.com",
    });

    const shot = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      `const p = await browser.getPage("main"); await p.shot(); return "shot";`,
    ]);
    assert.equal(shot.code, 0, shot.stderr);
    const image = JSON.parse(shot.stdout).images[0];
    assert.equal(image.mimeType, "image/jpeg");
    assert.ok(image.width > 100 && image.height > 100);
    assert.ok(jpegSize(readFileSync(image.path)));

    // A person's input in the panel reaches the same page.
    const focused = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      `const p = await browser.getPage("main"); await p.locator("#email").focus(); return "focused";`,
    ]);
    assert.equal(focused.code, 0, focused.stderr);
    const typed = await host(data, [
      "input",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--kind",
      "type",
      "--text",
      "from the panel",
    ]);
    assert.equal(typed.code, 0, typed.stderr);
    const pressed = await host(data, [
      "input",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--kind",
      "press",
      "--key",
      "Enter",
    ]);
    assert.equal(pressed.code, 0, pressed.stderr);
    const after = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      id,
      "--script",
      `const p = await browser.getPage("main");
       return { email: await p.locator("#email").inputValue(), title: await p.title() };`,
    ]);
    assert.equal(after.code, 0, after.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(after.stdout).text), {
      email: "agent@example.comfrom the panel",
      title: "key:Enter",
    });

    const captured = await host(data, ["screenshot", "--thread", "thread-1", "--session", id]);
    assert.equal(captured.code, 0, captured.stderr);
    assert.ok(existsSync(JSON.parse(captured.stdout).text));

    const pages = await host(data, ["pages", "--thread", "thread-1", "--session", id]);
    assert.equal(pages.code, 0, pages.stderr);
    const listed = JSON.parse(JSON.parse(pages.stdout).text);
    assert.equal(listed[0].name, "main");
    assert.match(listed[0].url, /fixture\.html/);

    const preview = await host(data, ["preview", "--thread", "thread-1", "--session", id]);
    assert.equal(preview.code, 0, preview.stderr);
    const frame = JSON.parse(preview.stdout).frame;
    assert.ok(frame.width > 100 && frame.height > 100);
    assert.ok(jpegSize(Buffer.from(frame.data, "base64")));
    assert.match(frame.url, /fixture\.html/);

    // Two runs at once serialize on the session instead of racing.
    const script = `const p = await browser.getPage("main"); return await p.title();`;
    const both = await Promise.all([
      host(data, ["run", "--thread", "thread-1", "--session", id, "--script", script]),
      host(data, ["run", "--thread", "thread-1", "--session", id, "--script", script]),
    ]);
    for (const result of both) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).text, "key:Enter");
    }

    const stopped = await host(data, ["stop", "--thread", "thread-1", "--session", id]);
    assert.equal(stopped.code, 0, stopped.stderr);
    const stoppedPages = await host(data, ["pages", "--thread", "thread-1", "--session", id]);
    assert.equal(stoppedPages.code, 1);
    assert.match(stoppedPages.stderr, /session_unavailable|stopped/);

    const again = JSON.parse((await host(data, ["open", "--thread", "thread-1"])).stdout);
    assert.equal((await host(data, ["close", "--thread", "thread-1", "--session", again.id])).code, 0);
    // The browser stays up for a grace period so a quick reopen keeps its
    // cookies, and the profile on disk keeps logins across a restart.
    assert.equal(existsSync(join(data, "browser.json")), true);
    assert.equal(existsSync(join(data, "profile")), true);
    const list = JSON.parse((await host(data, ["list", "--thread", "thread-1"])).stdout);
    assert.equal(list.find((entry) => entry.id === again.id).state, "closed");
    assert.deepEqual(JSON.parse((await host(data, ["shutdown"])).stdout), { stopped: true });
    assert.equal(existsSync(join(data, "browser.json")), false);
    assert.equal(existsSync(join(data, "profile")), true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a script that never returns is stopped at its timeout", {
  timeout: 120_000,
  skip: skip || needsChrome,
}, async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-e2e-"));
  try {
    await host(data, ["prepare"]);
    const session = JSON.parse((await host(data, ["open", "--thread", "thread-2"])).stdout);
    const result = await host(data, [
      "run",
      "--thread",
      "thread-2",
      "--session",
      session.id,
      "--script",
      "for (;;) {}",
      "--timeout-ms",
      "1000",
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /session_unavailable|stopped/);
    const list = JSON.parse((await host(data, ["list", "--thread", "thread-2"])).stdout);
    assert.equal(list[0].state, "stopped");
    await host(data, ["shutdown"]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a named page persists as a tab between runs", {
  timeout: 120_000,
  skip: skip || needsChrome,
}, async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-e2e-"));
  const page = join(data, "one.html");
  writeFileSync(page, "<title>named</title><h1>Named</h1>");
  try {
    await host(data, ["prepare"]);
    const session = JSON.parse((await host(data, ["open", "--thread", "thread-3"])).stdout);
    const first = await host(data, [
      "run",
      "--thread",
      "thread-3",
      "--session",
      session.id,
      "--script",
      `const p = await browser.getPage("work");
       await p.goto(${JSON.stringify(`file://${page}`)});
       return await p.title();`,
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).text, "named");
    const second = await host(data, [
      "run",
      "--thread",
      "thread-3",
      "--session",
      session.id,
      "--script",
      `const p = await browser.getPage("work"); return await p.title();`,
    ]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).text, "named");
    const pages = JSON.parse(
      JSON.parse((await host(data, ["pages", "--thread", "thread-3", "--session", session.id])).stdout).text,
    );
    assert.deepEqual(pages.map((entry) => entry.name).sort(), ["main", "work"]);
    await host(data, ["close", "--thread", "thread-3", "--session", session.id]);
    await host(data, ["shutdown"]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("the right-sidebar page paints a frame and forwards input", {
  timeout: 180_000,
  skip: skip || needsChrome,
}, async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-panel-"));
  try {
    await host(data, ["prepare"]);
    const require = createRequire(join(data, "runtime", "package.json"));
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__posted = [];
        window.kagan = { post: (message) => window.__posted.push(message) };
      });
      const local = fileURLToPath(new URL("./ui/index.html", import.meta.url));
      await page.goto(`file://${local}`);
      await page.waitForFunction(() => window.__posted.some((item) => item.type === "state"));

      const ready = {
        id: "11111111-2222-3333-4444-555555555555",
        state: "ready",
        url: "https://example.com/",
        title: "Example",
        headless: true,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      await page.evaluate((session) => {
        window.dispatchEvent(
          new CustomEvent("kagan", {
            detail: { type: "state", threadId: "thread-1", sessions: [session, { ...session, id: "stopped-one", state: "stopped" }] },
          }),
        );
      }, ready);
      await page.locator("#sessions li").first().waitFor();
      assert.match(await page.locator("#sessions").innerText(), /11111111/);
      assert.match(await page.locator("#state").innerText(), /ready/);

      // The page asks for a frame; answer the request it made, with a real JPEG.
      const asked = await page.waitForFunction(() => {
        const frames = window.__posted.filter((item) => item.type === "frame");
        return frames.length > 0 ? frames.at(-1) : false;
      });
      const request = await asked.jsonValue();
      const jpeg = (await page.screenshot({ type: "jpeg", quality: 40 })).toString("base64");
      await page.evaluate(
        ({ data, request, id }) => {
          window.dispatchEvent(
            new CustomEvent("kagan", {
              detail: {
                type: "frame",
                request,
                id,
                sequence: 1,
                mimeType: "image/jpeg",
                data,
                width: 640,
                height: 400,
                scale: 1,
                url: "https://example.com/",
                title: "Example",
              },
            }),
          );
        },
        { data: jpeg, request: request.request, id: request.id },
      );
      await page.waitForFunction(() => document.getElementById("frame").src.startsWith("data:image/jpeg"));
      assert.match(await page.locator("#url").innerText(), /example\.com/);
      assert.equal(request.id, ready.id);

      await page.locator("#frame").click({ position: { x: 20, y: 20 } });
      await page.locator("#text").fill("hello");
      await page.locator("#text").press("Enter");
      const posted = await page.evaluate(() => window.__posted);
      const click = posted.find((item) => item.type === "click");
      assert.equal(click.id, ready.id);
      assert.ok(Number.isFinite(click.x) && Number.isFinite(click.y));
      assert.deepEqual(posted.filter((item) => item.type === "type").at(-1), {
        type: "type",
        id: ready.id,
        text: "hello",
      });
      assert.ok(posted.some((item) => item.type === "press" && item.key === "Enter"));
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a login survives closing the session", {
  timeout: 180_000,
  skip: skip || needsChrome,
}, async () => {
  const data = mkdtempSync(join(tmpdir(), "browser-login-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>auth</title><p>auth</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  try {
    await host(data, ["prepare"]);
    const first = JSON.parse((await host(data, ["open", "--thread", "thread-1"])).stdout);
    const signedIn = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      first.id,
      "--script",
      `const p = await browser.getPage("main");
       await p.goto(${JSON.stringify(url)});
       await p.evaluate(() => { localStorage.setItem("token", "abc"); document.cookie = "auth=abc; path=/"; });
       return "signed in";`,
    ]);
    assert.equal(signedIn.code, 0, signedIn.stderr);
    const browserPid = JSON.parse(readFileSync(join(data, "browser.json"), "utf8")).pid;
    assert.equal((await host(data, ["close", "--thread", "thread-1", "--session", first.id])).code, 0);

    const second = JSON.parse((await host(data, ["open", "--thread", "thread-1"])).stdout);
    assert.notEqual(second.id, first.id);
    assert.equal(JSON.parse(readFileSync(join(data, "browser.json"), "utf8")).pid, browserPid);
    const remembered = await host(data, [
      "run",
      "--thread",
      "thread-1",
      "--session",
      second.id,
      "--script",
      `const p = await browser.getPage("main");
       await p.goto(${JSON.stringify(url)});
       return {
         token: await p.evaluate(() => localStorage.getItem("token")),
         cookie: await p.evaluate(() => document.cookie),
       };`,
    ]);
    assert.equal(remembered.code, 0, remembered.stderr);
    const state = JSON.parse(JSON.parse(remembered.stdout).text);
    assert.equal(state.token, "abc");
    // A session cookie, the kind a login sets without an expiry, survives too
    // because the browser never stopped.
    assert.match(state.cookie, /auth=abc/);
    await host(data, ["close", "--thread", "thread-1", "--session", second.id]);
    await host(data, ["shutdown"]);
  } finally {
    server.close();
    rmSync(data, { recursive: true, force: true });
  }
});
