import test from "node:test";
import assert from "node:assert/strict";
import { createShow, cueAtOrBefore, formatTimestamp, normalizeCue, normalizeShow, resolvePublishedAudioUrl } from "../src/show-format.js";

test("normalizes, rounds, and sorts cues", () => {
  const show = createShow({
    title: "Test",
    file: { name: "track.mp3", type: "audio/mpeg", size: 42, lastModified: 99 },
    duration: 12.3456,
    cues: [
      { id: "b", time: 5.4321, mode: "off" },
      { id: "a", time: 0, mode: "solid", color: "#FF5FA2", brightness: 7 },
    ],
  });

  assert.equal(show.track.duration, 12.346);
  assert.deepEqual(show.cues.map((cue) => cue.id), ["a", "b"]);
  assert.equal(show.cues[0].color, "#ff5fa2");
});

test("normalizes the cue offset", () => {
  const show = createShow({
    file: { name: "track.mp3" },
    duration: 10,
    cues: [],
    cueOffsetMs: 250,
  });
  assert.equal(show.cueOffsetMs, 250);
  assert.equal(createShow({ file: { name: "track.mp3" }, duration: 10, cues: [] }).cueOffsetMs, 0);
  assert.throws(
    () => normalizeShow({ format: "candybong-show", version: 1, track: { duration: 5 }, cueOffsetMs: 1001 }),
    /Cue offset/,
  );
});

test("rejects malformed shows and out-of-range protocol values", () => {
  assert.throws(() => normalizeShow({ format: "wrong", version: 1 }), /Unsupported show format/);
  assert.throws(() => normalizeCue({ time: 1, mode: "solid", brightness: 11 }), /Brightness/);
  assert.throws(() => normalizeCue({ time: -1, mode: "off" }), /Cue time/);
});

test("finds the active persistent cue", () => {
  const cues = [
    normalizeCue({ id: "one", time: 0, mode: "solid" }),
    normalizeCue({ id: "two", time: 3, mode: "pulse" }),
  ];
  assert.equal(cueAtOrBefore(cues, 2.9)?.id, "one");
  assert.equal(cueAtOrBefore(cues, 3)?.id, "two");
  assert.equal(cueAtOrBefore(cues, -1), null);
});

test("formats timeline timestamps", () => {
  assert.equal(formatTimestamp(65.2), "1:05.20");
});

test("resolves only same-origin published audio", () => {
  assert.equal(
    resolvePublishedAudioUrl("song.mp3", "https://example.com/shows/demo.json", "https://example.com"),
    "https://example.com/shows/song.mp3",
  );
  assert.throws(
    () => resolvePublishedAudioUrl("https://cdn.example.net/song.mp3", "https://example.com/show.json", "https://example.com"),
    /same web origin/,
  );
});
