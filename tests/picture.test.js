import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitJpeg, shrinkPicture, choosePicture, isPicture, PICTURE_BAD } from "../js/picture.js";

const JPEG = JSON.parse(readFileSync(new URL("./fixtures/picture.json", import.meta.url), "utf8")).jpeg;
const HEAD = "data:image/jpeg;base64,";

// A canvas whose JPEG at quality q is size(q) characters long; it records what it was asked.
// (A data address's base64 part is a multiple of 4 long: sizes here are 23 + 4n.)
function fakeCanvas(size) {
  const asked = [];
  const drawn = [];
  return {
    asked,
    drawn,
    width: 0,
    height: 0,
    getContext: () => ({ fillRect() {}, drawImage: (...a) => drawn.push(a) }),
    toDataURL(type, q) {
      asked.push([type, q]);
      return HEAD + "A".repeat(size(q) - HEAD.length);
    },
  };
}

test("the shrink step keeps the first quality that fits: 0.8 when it fits at once", () => {
  const c = fakeCanvas(() => 9003);
  assert.equal(fitJpeg(c).length, 9003);
  assert.deepEqual(c.asked, [["image/jpeg", 0.8]]);
});

test("the shrink step steps down until it fits: here only at 0.5", () => {
  const c = fakeCanvas((q) => (q > 0.5 ? 12003 : 11003));
  assert.equal(fitJpeg(c).length, 11003);
  assert.deepEqual(c.asked.map((a) => a[1]), [0.8, 0.7, 0.6, 0.5]);
});

test("a picture that never fits by 0.4 gives nothing; the person is told and nothing is sent", async () => {
  const c = fakeCanvas(() => 20003);
  assert.equal(fitJpeg(c), null);
  assert.deepEqual(c.asked.map((a) => a[1]), [0.8, 0.7, 0.6, 0.5, 0.4]);

  const told = [];
  const sent = [];
  const big = { type: "image/jpeg" };
  const ok = await choosePicture(big, {
    shrink: (f) => shrinkPicture(f, { decode: async () => ({ width: 600, height: 400 }), makeCanvas: () => fakeCanvas(() => 20003) }),
    save: async (url) => sent.push(url),
    notify: (t) => told.push(t),
  });
  assert.equal(ok, false);
  assert.deepEqual(told, [PICTURE_BAD]);
  assert.equal(PICTURE_BAD, "That picture couldn’t be used. Try another.");
  assert.deepEqual(sent, []);
});

test("a picture is cropped to the centred square and drawn at 128 x 128 before it is sent", async () => {
  const c = fakeCanvas(() => 5003);
  const sent = [];
  const ok = await choosePicture({ type: "image/png" }, {
    shrink: (f) => shrinkPicture(f, { decode: async () => ({ width: 600, height: 400 }), makeCanvas: () => c }),
    save: async (url) => (sent.push(url), true),
    notify: () => assert.fail("no notice"),
  });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual([c.width, c.height], [128, 128]);
  assert.deepEqual(c.drawn[0].slice(1), [100, 0, 400, 400, 0, 0, 128, 128]);
});

test("a file that is not a picture, or will not decode, is turned away the same way", async () => {
  const canvas = () => fakeCanvas(() => 5003);
  assert.equal(await shrinkPicture({ type: "application/pdf" }, { decode: async () => ({ width: 10, height: 10 }), makeCanvas: canvas }), null);
  assert.equal(await shrinkPicture({ type: "image/jpeg" }, { decode: async () => { throw new Error("bad"); }, makeCanvas: canvas }), null);
  assert.equal(await shrinkPicture({ type: "image/jpeg" }, { decode: async () => ({ width: 0, height: 0 }), makeCanvas: canvas }), null);
  assert.equal(await shrinkPicture(null, { decode: async () => ({ width: 10, height: 10 }), makeCanvas: canvas }), null);
  const told = [];
  assert.equal(await choosePicture({ type: "text/plain" }, { save: () => assert.fail("nothing sent"), notify: (t) => told.push(t) }), false);
  assert.deepEqual(told, [PICTURE_BAD]);
});

test("only a JPEG data address of at most 12,000 characters counts as a picture", () => {
  assert.equal(isPicture(JPEG), true);
  assert.equal(isPicture(""), false);
  assert.equal(isPicture("data:image/png;base64,AAAA"), false);
  assert.equal(isPicture("javascript:alert(1)"), false);
  assert.equal(isPicture(HEAD + "AA\"AA"), false);
  assert.equal(isPicture(HEAD + "A".repeat(12001 - HEAD.length)), false);
  assert.equal(isPicture(undefined), false);
});

test("a picture's base64 part is a whole number of 4-character groups", () => {
  assert.equal(isPicture(HEAD + "A"), false, "one character");
  assert.equal(isPicture(HEAD + "AAAAA"), false);
  assert.equal(isPicture(HEAD + "AA="), false);
  assert.equal(isPicture(HEAD + "AAAA"), true);
  assert.equal(isPicture(HEAD + "AAA="), true);
  assert.equal(isPicture(HEAD + "AA=="), true);
  assert.equal(isPicture(HEAD + "A".repeat(11976)), true, "11,999 characters, the longest that can be whole groups");
});

test("a canvas that throws while drawing or exporting ends as a picture that cannot be used", async () => {
  const decode = async () => ({ width: 600, height: 400 });
  const throwsOnDraw = () => ({ ...fakeCanvas(() => 5003), getContext: () => ({ fillRect() {}, drawImage() { throw new Error("out of memory"); } }) });
  const throwsOnExport = () => ({ ...fakeCanvas(() => 5003), toDataURL() { throw new Error("odd codec"); } });
  const throwsOnContext = () => ({ ...fakeCanvas(() => 5003), getContext() { throw new Error("no context"); } });
  for (const makeCanvas of [throwsOnDraw, throwsOnExport, throwsOnContext]) {
    assert.equal(await shrinkPicture({ type: "image/jpeg" }, { decode, makeCanvas }), null);
    const told = [];
    const ok = await choosePicture({ type: "image/jpeg" }, {
      shrink: (f) => shrinkPicture(f, { decode, makeCanvas }),
      save: () => assert.fail("nothing sent"),
      notify: (t) => told.push(t),
    });
    assert.equal(ok, false);
    assert.deepEqual(told, [PICTURE_BAD]);
  }
});
