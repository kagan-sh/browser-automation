// The right-sidebar browser: it asks the plugin for the session list and for a
// fresh JPEG of the page it drives, and paints it. Nothing here clicks the page;
// scripts do that, so what you see is what the agent sees.
const FRAME_MS = 1500;
const STATE_TICKS = 3;
const FRAME_TIMEOUT_MS = 8000;

const el = {
  state: document.getElementById("state"),
  frame: document.getElementById("frame"),
  empty: document.getElementById("empty"),
  title: document.getElementById("title"),
  url: document.getElementById("url"),
  sessions: document.getElementById("sessions"),
  error: document.getElementById("error"),
  open: document.getElementById("open"),
  refresh: document.getElementById("refresh"),
  stop: document.getElementById("stop"),
  close: document.getElementById("close"),
  text: document.getElementById("text"),
  send: document.getElementById("send"),
  enter: document.getElementById("enter"),
};

let sessions = [];
let selected = "";
let threadId = "";
let request = 0;
let frameInFlight = 0;
let ticks = 0;
let shown = "";
let frameWidth = 1280;
let frameHeight = 800;
let frameScale = 1;
let opening = false;

function send(message) {
  if (window.kagan) window.kagan.post(message);
}

function isReady() {
  return sessions.some((session) => session.id === selected && session.state === "ready");
}

function current() {
  return sessions.find((session) => session.id === selected);
}

function chosen() {
  if (isReady()) return selected;
  const ready = sessions.filter((session) => session.state === "ready").at(-1);
  return ready ? ready.id : "";
}

function showError(text) {
  el.error.textContent = text;
  el.error.hidden = !text;
}

function paint() {
  if (!sessions.some((session) => session.id === selected)) selected = chosen();
  const session = current();
  const live = session && session.state === "ready";
  el.state.textContent = !session
    ? "No session"
    : `${session.state} · ${session.id.slice(0, 8)}`;
  el.state.title = session ? `${threadId} · ${session.id}` : "";
  el.open.disabled = opening;
  el.stop.disabled = !live;
  el.close.disabled = !session;
  el.refresh.disabled = false;
  el.text.disabled = !live;
  el.send.disabled = !live;
  el.enter.disabled = !live;
  el.empty.hidden = Boolean(live);
  if (!live) {
    el.frame.hidden = true;
    el.frame.removeAttribute("src");
    shown = "";
    el.title.textContent = session ? (session.title || "(no page yet)") : "";
    el.url.textContent = session ? session.url : "";
    el.empty.querySelector("#empty-title").textContent = sessions.length
      ? "That session is stopped"
      : "No browser session";
  }
  el.sessions.replaceChildren(
    ...sessions.map((entry) => {
      const item = document.createElement("li");
      item.className = entry.id === selected ? "selected" : "";
      item.dataset.id = entry.id;
      const dot = document.createElement("span");
      dot.className = `dot ${entry.state}`;
      const id = document.createElement("span");
      id.className = "id";
      id.textContent = entry.id.slice(0, 8);
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = entry.url || "about:blank";
      item.append(dot, id, where);
      item.addEventListener("click", () => {
        selected = entry.id;
        requestState();
      });
      return item;
    }),
  );
}

function requestState() {
  send({ type: "state" });
}

function requestFrame() {
  if (frameInFlight) return;
  if (document.hidden || !isReady()) return;
  frameInFlight = request = request + 1;
  send({ type: "frame", id: selected, request });
  const mine = request;
  setTimeout(() => {
    if (frameInFlight === mine) frameInFlight = 0;
  }, FRAME_TIMEOUT_MS);
}

function paintFrame(message) {
  if (message.request !== frameInFlight) return;
  frameInFlight = 0;
  if (message.failed || !message.data) return;
  if (message.sequence && message.sequence === shown) return;
  shown = message.sequence;
  frameWidth = message.width || frameWidth;
  frameHeight = message.height || frameHeight;
  frameScale = message.scale || 1;
  el.frame.src = `data:${message.mimeType || "image/jpeg"};base64,${message.data}`;
  el.frame.hidden = false;
  el.title.textContent = message.title || "(no title)";
  el.url.textContent = message.url || "";
}

window.addEventListener("kagan", (event) => {
  const message = event.detail;
  if (!message || typeof message !== "object") return;
  if (message.type === "state") {
    opening = false;
    threadId = message.threadId || "";
    sessions = Array.isArray(message.sessions) ? message.sessions : [];
    showError("");
    paint();
    return;
  }
  if (message.type === "selected") {
    selected = String(message.id || "");
    paint();
    return;
  }
  if (message.type === "frame") {
    paintFrame(message);
    return;
  }
  if (message.type === "failed") {
    showError(message.message || "The browser panel failed.");
    el.open.disabled = opening;
    requestState();
  }
});

/** A point in the frame, as CSS pixels in the page. */
function place(event) {
  const box = el.frame.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
  return {
    x: Math.round(((event.clientX - box.left) / box.width) * (frameWidth / frameScale)),
    y: Math.round(((event.clientY - box.top) / box.height) * (frameHeight / frameScale)),
  };
}

el.frame.addEventListener("click", (event) => {
  if (!isReady()) return;
  const { x, y } = place(event);
  send({ type: "click", id: selected, x, y });
});

el.frame.addEventListener(
  "wheel",
  (event) => {
    if (!isReady()) return;
    event.preventDefault();
    send({ type: "wheel", id: selected, delta: Math.round(event.deltaY) });
  },
  { passive: false },
);

function submitText(enter) {
  if (!isReady()) return;
  const text = el.text.value;
  if (text !== "") send({ type: "type", id: selected, text });
  if (enter) send({ type: "press", id: selected, key: "Enter" });
  el.text.value = "";
}

el.send.addEventListener("click", (event) => {
  event.preventDefault();
  submitText(false);
});
el.enter.addEventListener("click", () => submitText(true));
el.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitText(true);
  }
});

el.open.addEventListener("click", () => {
  opening = true;
  el.open.disabled = true;
  showError("");
  send({ type: "open" });
});
el.refresh.addEventListener("click", requestState);
el.stop.addEventListener("click", () => send({ type: "stop", id: selected }));
el.close.addEventListener("click", () => send({ type: "close", id: selected }));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    requestState();
    requestFrame();
  }
});

function tick() {
  ticks += 1;
  if (!document.hidden) {
    if (ticks % STATE_TICKS === 0 || sessions.length === 0) requestState();
    requestFrame();
  }
  setTimeout(tick, FRAME_MS);
}

paint();
requestState();
tick();
