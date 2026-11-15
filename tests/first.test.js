import test from "node:test";
import assert from "node:assert/strict";
import { keyFromPaste } from "../js/views/first.js";

test("keyFromPaste takes the key from an invite link, or a bare key, trimmed", () => {
  assert.equal(keyFromPaste("https://example.github.io/mat/#k=3f2a9c0d1e4b5a6978c0d1e2"), "3f2a9c0d1e4b5a6978c0d1e2");
  assert.equal(keyFromPaste("  http://localhost:4173/#k=test-key \n"), "test-key");
  assert.equal(keyFromPaste("http://localhost:4173/#x=1&k=test-key"), "test-key");
  assert.equal(keyFromPaste("#k=test%2Dkey"), "test-key");
  assert.equal(keyFromPaste("3f2a9c0d1e4b5a6978c0d1e2"), "3f2a9c0d1e4b5a6978c0d1e2");
});

test("keyFromPaste refuses what cannot be a key", () => {
  for (const bad of [undefined, null, "", "   ", "abc", "hello there", "http://localhost:4173/", "http://localhost:4173/#x=1", "#k=", "#k=%E0%A4%A", "#k=a b c d e f", "<script>"]) {
    assert.equal(keyFromPaste(bad), null, JSON.stringify(bad));
  }
});
