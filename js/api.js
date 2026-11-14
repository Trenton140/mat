// One call to the trip backend: api(action, args) -> Promise<{ rev, data }>.
// Rejects with an Error whose .code is the backend's error code, "network"
// when the request itself fails, or "server" when the reply is not an
// envelope. The trip key travels only in the request body: never in the URL,
// an error message or a log line.

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const NO_SIGNAL = "Couldn't reach the trip sheet.";
const BAD_REPLY = "The trip sheet sent back something unexpected.";

export function createApi({ url, getKey, getActor, fetchImpl }) {
  return async function api(action, args = {}) {
    const body = { key: getKey(), actor: getActor(), via: "app", action, args };
    let env;
    const fake = globalThis.MAT_FAKE_API;
    if (typeof fake === "function") {
      try {
        env = await fake(body);
      } catch {
        throw fail("network", NO_SIGNAL);
      }
    } else {
      const doFetch = fetchImpl || globalThis.fetch;
      if (!url || typeof doFetch !== "function") throw fail("network", NO_SIGNAL);
      let text;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(body),
        });
        text = await res.text();
      } catch {
        throw fail("network", NO_SIGNAL);
      }
      try {
        env = JSON.parse(text);
      } catch {
        throw fail("server", BAD_REPLY);
      }
    }
    if (!env || typeof env !== "object" || typeof env.ok !== "boolean") throw fail("server", BAD_REPLY);
    if (!env.ok) throw fail(typeof env.error === "string" ? env.error : "server", typeof env.message === "string" ? env.message : BAD_REPLY);
    return { rev: env.rev, data: env.data };
  };
}
