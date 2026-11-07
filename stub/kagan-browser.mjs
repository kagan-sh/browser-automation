export const calls = [];

/** @type {Error | null} */
let failure = null;

export function reset() {
  calls.length = 0;
  failure = null;
}

/** @param {Error} error */
export function failNext(error) {
  failure = error;
}

/**
 * @param {string} verb
 * @param {unknown[]} args
 * @param {unknown} value
 */
function call(verb, args, value) {
  calls.push({ verb, args });
  if (failure) {
    const error = failure;
    failure = null;
    throw error;
  }
  return Promise.resolve(value);
}

const view = (threadId, url = "https://example.com/") => ({
  threadId,
  thread: "Example thread",
  url,
  title: "Example",
  shown: true,
});

export const open = (threadId, url) => call("open", [threadId, url], view(threadId, url));
export const status = (threadId) => call("status", [threadId], view(threadId));
export const snapshot = (threadId) =>
  call("snapshot", [threadId], {
    url: "https://example.com/",
    title: "Example",
    controls: [{ ref: 2, role: "textbox", name: "Email", value: "", focused: false, disabled: false }],
    text: "Hello",
    truncated: false,
  });
export const goto = (threadId, url) => call("goto", [threadId, url], undefined);
export const back = (threadId) => call("back", [threadId], undefined);
export const forward = (threadId) => call("forward", [threadId], undefined);
export const reload = (threadId) => call("reload", [threadId], undefined);
export const click = (threadId, ref) => call("click", [threadId, ref], undefined);
export const fill = (threadId, ref, text) => call("fill", [threadId, ref, text], undefined);
export const type = (threadId, text) => call("type", [threadId, text], undefined);
export const press = (threadId, key) => call("press", [threadId, key], undefined);
export const select = (threadId, ref, option) => call("select", [threadId, ref, option], undefined);
export const scroll = (threadId, dy) => call("scroll", [threadId, dy], undefined);
export const close = (threadId) => call("close", [threadId], undefined);
