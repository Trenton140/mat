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

const NO_SIGNAL = "Couldn’t reach the trip sheet.";
// How long one request may take, reply included, before it counts as no
// signal. Weak signal must not leave requests piling up.
export const API_TIMEOUT_MS = 30000;
const BAD_REPLY = "The trip sheet sent back something unexpected.";

export function createApi({ url, getKey, getActor, fetchImpl, timeoutMs = API_TIMEOUT_MS }) {
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
      const abort = typeof AbortController === "function" ? new AbortController() : null;
      let timer;
      // Gives up at the timeout even if the fetch ignores the abort.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (abort) abort.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
        // Under Node (the unit tests) a pending request must not hold the process open.
        if (timer && typeof timer.unref === "function") timer.unref();
      });
      try {
        const request = (async () => {
          const res = await doFetch(url, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(body),
            signal: abort ? abort.signal : undefined,
          });
          return res.text();
        })();
        request.catch(() => {}); // when the timeout wins, its later failure is not news
        text = await Promise.race([request, timeout]);
      } catch {
        throw fail("network", NO_SIGNAL);
      } finally {
        clearTimeout(timer);
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
