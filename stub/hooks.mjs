export async function resolve(specifier, context, next) {
  if (specifier === "kagan/browser") {
    return {
      shortCircuit: true,
      url: new URL("./kagan-browser.mjs", import.meta.url).href,
    };
  }
  return next(specifier, context);
}
