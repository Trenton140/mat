// The outside-world primitives Actions.js uses besides the Sheet helpers.
// Apps Script only; tests/fake-backend.cjs supplies in-memory versions.

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

// Runs fn under the script lock. If the lock is not free within 8 seconds,
// returns the busy envelope instead (handle_ adds rev).
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return { ok: false, error: "busy", message: "Someone else is saving right now. Try again in a moment." };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function nowIso_() {
  return new Date().toISOString();
}

function sheetUrl_() {
  return SpreadsheetApp.getActiveSpreadsheet().getUrl();
}
