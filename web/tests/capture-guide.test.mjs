import test from "node:test";
import assert from "node:assert/strict";
import { captureSourceRect } from "../src/camera-luma.js";
import { CAPTURE_SIZE } from "../src/capture-guide.js";

test("captureSourceRect crops the centered square of a landscape frame", () => {
  assert.deepEqual(captureSourceRect(640, 480, 0.7), { side: 336, sx: 152, sy: 72 });
});

test("captureSourceRect crops a 16:9 frame", () => {
  assert.deepEqual(captureSourceRect(1280, 720, 0.7), { side: 504, sx: 388, sy: 108 });
});

test("captureSourceRect crops a square frame", () => {
  assert.deepEqual(captureSourceRect(480, 480, 0.7), { side: 336, sx: 72, sy: 72 });
});

test("captureSourceRect crops a portrait frame", () => {
  assert.deepEqual(captureSourceRect(720, 1280, 0.7), { side: 504, sx: 108, sy: 388 });
});

test("captureSourceRect with roiFraction 1 captures the whole shorter edge", () => {
  assert.deepEqual(captureSourceRect(640, 480, 1), { side: 480, sx: 80, sy: 0 });
});

test("captureSourceRect places the crop at an offset position", () => {
  assert.deepEqual(captureSourceRect(640, 480, 0.7, 0, 0), { side: 336, sx: 80, sy: 0 });
  assert.deepEqual(captureSourceRect(640, 480, 0.7, 1, 1), { side: 336, sx: 224, sy: 144 });
});

test("captureSourceRect clamps positions that would overflow the visible region", () => {
  assert.deepEqual(captureSourceRect(640, 480, 0.7, 0.1, 0.9), { side: 336, sx: 80, sy: 144 });
  for (const [w, h, x, y] of [
    [640, 480, 0, 0],
    [640, 480, 1, 1],
    [1280, 720, 0.25, 0.75],
    [720, 1280, 0, 1],
  ]) {
    const rect = captureSourceRect(w, h, 0.7, x, y);
    assert.ok(rect.sx >= 0 && rect.sy >= 0, `negative origin for ${w}×${h} at (${x}, ${y})`);
    assert.ok(rect.sx + rect.side <= w && rect.sy + rect.side <= h, `crop overflows ${w}×${h} at (${x}, ${y})`);
  }
});

test("captureSourceRect rounds sub-pixel crop sizes without overflowing", () => {
  const result = captureSourceRect(100, 100, 0.333);
  assert.deepEqual(result, { side: 33, sx: 33, sy: 33 });
  assert.ok(result.sx + result.side <= 100);
  assert.ok(result.sy + result.side <= 100);
});

test("captureSourceRect floors tiny cameras to a 1px crop inside the frame", () => {
  const result = captureSourceRect(2, 3, 0.1);
  assert.equal(result.side, 1);
  assert.ok(result.sx >= 0 && result.sy >= 0);
  assert.ok(result.sx + result.side <= 2 && result.sy + result.side <= 3);
});

test("captureSourceRect returns null for degenerate dimensions", () => {
  assert.equal(captureSourceRect(0, 0), null);
  assert.equal(captureSourceRect(-1, 480), null);
  assert.equal(captureSourceRect(NaN, 480), null);
});

test("captureSourceRect rejects invalid roiFraction", () => {
  for (const bad of [0, 1.01, -0.5, NaN]) {
    assert.throws(() => captureSourceRect(640, 480, bad), RangeError);
  }
});

test("captureSourceRect rejects positions outside [0, 1]", () => {
  assert.throws(() => captureSourceRect(640, 480, 0.7, -0.1), RangeError);
  assert.throws(() => captureSourceRect(640, 480, 0.7, 1.1), RangeError);
  assert.throws(() => captureSourceRect(640, 480, 0.7, 0.5, NaN), RangeError);
});

test("CAPTURE_SIZE is the standard detection input size", () => {
  assert.equal(CAPTURE_SIZE, 224);
});
