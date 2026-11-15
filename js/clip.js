// Puts text on the clipboard: copyText(text) -> Promise<true | false>.
// `text` may be a promise of the text: it then goes in as a ClipboardItem so
// Safari still counts the tap that started it, even when the text takes a
// moment to build. Falls back to writeText, then to the selection copy that
// older phones need. Nothing here runs at import time.

export async function copyText(text) {
  const clip = globalThis.navigator && globalThis.navigator.clipboard;
  try {
    if (typeof text !== "string" && globalThis.ClipboardItem && clip && clip.write) {
      const blob = Promise.resolve(text).then((t) => new Blob([t], { type: "text/plain" }));
      blob.catch(() => {}); // a text that cannot be built is answered below, not left unhandled
      await clip.write([new globalThis.ClipboardItem({ "text/plain": blob })]);
      return true;
    }
  } catch {
    // fall through to the plain copy below
  }
  let plain;
  try {
    plain = await text;
  } catch {
    return false; // the text could not be built: nothing to copy
  }
  try {
    await clip.writeText(plain);
    return true;
  } catch {
    // an older phone: fall back to the selection copy
  }
  try {
    const t = document.createElement("textarea");
    t.value = plain;
    t.setAttribute("readonly", "");
    t.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch {
    return false;
  }
}
