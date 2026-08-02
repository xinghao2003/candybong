import test from "node:test";
import assert from "node:assert/strict";
import { cameraErrorMessage, cameraSupportMessage, createEdgeDetector } from "./camera-luma.js";
import {
  SWEEP_STEP_TIMEOUT_MIN_MS,
  averagePeriodMs,
  blinksPerMinute,
  createSweepMeasurement,
  defaultSpeedForBpm,
  linearFit,
  lumaOfHex,
  speedForTargetBpm,
  stepTimeoutMs,
} from "./blink-lab.js";

// Deterministic PRNG so noisy tests never flake.
function makeRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function runSimulation(detector, totalMs, stepMs, lumaAt, collect = () => {}) {
  const rises = [];
  const periods = [];
  let lastRiseAt = null;
  const frames = Math.ceil(totalMs / stepMs);
  for (let frame = 0; frame < frames; frame += 1) {
    const timeMs = frame * stepMs;
    const result = detector.step(lumaAt(timeMs), timeMs);
    collect(result);
    if (result.edge === "rise") {
      if (lastRiseAt !== null) periods.push(result.edgeAt - lastRiseAt);
      lastRiseAt = result.edgeAt;
      rises.push(result.edgeAt);
    }
  }
  return { rises, periods, lastRiseAt };
}

test("edge detector measures a clean square wave", () => {
  const detector = createEdgeDetector({ windowFrames: 90 });
  const { rises, periods } = runSimulation(
    detector,
    6700,
    16.7,
    (timeMs) => (Math.floor(timeMs / 250) % 2 === 0 ? 220 : 25),
  );
  assert.ok(rises.length >= 6, `expected at least 6 rising edges, got ${rises.length}`);
  for (const period of periods) {
    assert.ok(Math.abs(period - 500) <= 40, `period ${period} ms should be near 500 ms`);
  }
});

test("edge detector ignores sub-confirm flicker", () => {
  const detector = createEdgeDetector({ windowFrames: 90 });
  const { rises, periods } = runSimulation(
    detector,
    4000,
    16.7,
    (timeMs) => (Math.floor(timeMs / 15) % 2 === 0 ? 220 : 25),
  );
  assert.equal(rises.length, 0);
  assert.equal(periods.length, 0);
});

test("edge detector resolves fast blinks when the confirm follows the frame interval", () => {
  // A 60 fps camera (~16.7 ms frames) yields a ~33 ms confirm debounce, which
  // an on-time of three frames (50 ms) clears.
  const detector = createEdgeDetector({ windowFrames: 90 });
  detector.confirmMs = 33;
  const { rises, periods } = runSimulation(
    detector,
    4000,
    16.7,
    (timeMs) => (Math.floor(timeMs / 50) % 2 === 0 ? 220 : 25),
  );
  assert.ok(rises.length >= 12, `expected at least 12 rising edges, got ${rises.length}`);
  for (const period of periods) {
    assert.ok(Math.abs(period - 100) <= 30, `period ${period} ms should be near 100 ms`);
  }
});

test("edge detector reports fast blink as waiting with high swing instead of edges", () => {
  // A one-frame on-time never clears the confirm window, but the rolling swing
  // stays high — this is the data behind the "too fast for the camera" hint.
  const detector = createEdgeDetector({ windowFrames: 90 });
  detector.confirmMs = 33;
  const samples = [];
  const { rises } = runSimulation(
    detector,
    4000,
    16.7,
    (timeMs) => (Math.floor(timeMs / 16.7) % 2 === 0 ? 220 : 25),
    (result) => samples.push(result),
  );
  assert.equal(rises.length, 0);
  assert.ok(samples.some((sample) => sample.swing > 60), "swing should reveal an alternating light");
  assert.ok(samples.every((sample) => sample.lastEdgeAt === null), "no edge should ever have fired");
});

test("edge detector stays stable under noise without double edges", () => {
  const random = makeRandom(1234);
  const detector = createEdgeDetector({ windowFrames: 90 });
  const { rises, periods } = runSimulation(
    detector,
    6000,
    16.7,
    (timeMs) => {
      const base = Math.floor(timeMs / 200) % 2 === 0 ? 200 : 30;
      return Math.round(base + (random() - 0.5) * 16);
    },
  );
  assert.ok(rises.length >= 6, `expected at least 6 rising edges, got ${rises.length}`);
  assert.ok(rises.length <= 12, `expected at most 12 rising edges, got ${rises.length}`);
  for (let index = 1; index < rises.length; index += 1) {
    assert.ok(rises[index] - rises[index - 1] >= 300, "no double edges within one cycle");
  }
  for (const period of periods) {
    assert.ok(Math.abs(period - 400) <= 30, `period ${period} ms should be near 400 ms`);
  }
});

test("edge detector margin fraction tunes how large a swing counts", () => {
  // Swing 100↔50 with the default 0.15 margin (7.5) fires edges; a strict
  // 0.6 margin (30) keeps the luma inside the dead zone, so nothing counts.
  const square = (timeMs) => (Math.floor(timeMs / 200) % 2 === 0 ? 100 : 50);
  const lax = createEdgeDetector({ windowFrames: 90, marginFraction: 0.1 });
  const { rises: laxRises } = runSimulation(lax, 3000, 16.7, square);
  assert.ok(laxRises.length >= 3, `loose margin should detect the blink, got ${laxRises.length}`);
  const strict = createEdgeDetector({ windowFrames: 90, marginFraction: 0.6 });
  const { rises: strictRises } = runSimulation(strict, 3000, 16.7, square);
  assert.equal(strictRises.length, 0, "strict margin should reject the small swing");
  // The fraction is stored on the detector, so the Blink Lab slider can
  // retune it live without restarting the camera.
  const mutable = createEdgeDetector({ windowFrames: 90 });
  const { rises: before } = runSimulation(mutable, 3000, 16.7, square);
  assert.ok(before.length >= 1, "default margin should fire edges first");
  mutable.marginFraction = 0.6;
  const { rises: after } = runSimulation(mutable, 3000, 16.7, square);
  assert.equal(after.length, 0, "raising the margin mid-run should stop new edges");
});

test("edge detector reports no-signal for a flat frame", () => {
  const detector = createEdgeDetector({ windowFrames: 90 });
  const states = [];
  runSimulation(detector, 3000, 16.7, () => 128, (result) => states.push(result.state));
  assert.ok(states.includes("no-signal"), "flat luma should reach the no-signal state");
});

test("edge detector reports solid after blinking stops", () => {
  const detector = createEdgeDetector({ windowFrames: 90 });
  const states = [];
  const { lastRiseAt } = runSimulation(
    detector,
    6400,
    16.7,
    (timeMs) => (timeMs < 2400 ? (Math.floor(timeMs / 400) % 2 === 0 ? 200 : 30) : 200),
    (result) => states.push(result.state),
  );
  assert.ok(states.includes("solid"), "state should become solid after edges stop");
  assert.notEqual(lastRiseAt, null);
});

test("median period and blinks-per-minute", () => {
  assert.equal(averagePeriodMs([100, 110, 5000]), 110);
  assert.equal(averagePeriodMs([]), null);
  assert.equal(blinksPerMinute(500), 120);
  assert.equal(blinksPerMinute(null), null);
  assert.equal(blinksPerMinute(-5), null);
});

test("perceived luma of hex colors", () => {
  assert.equal(lumaOfHex("#ffffff"), 255);
  assert.equal(lumaOfHex("#000000"), 0);
  assert.equal(lumaOfHex("#ff5fa2"), 134);
  assert.equal(lumaOfHex("not-a-color"), 255);
});

test("linear fit recovers a deterministic line", () => {
  const speeds = [10, 40, 100, 180, 255];
  const fit = linearFit(speeds.map((speed) => ({ speed, periodMs: 1500 - 5.2 * speed })));
  assert.equal(fit.valid, true);
  assert.ok(Math.abs(fit.slope - -5.2) < 1e-9, `slope ${fit.slope} should be -5.2`);
  assert.ok(Math.abs(fit.intercept - 1500) < 1e-9, `intercept ${fit.intercept} should be 1500`);
  assert.ok(fit.rSquared >= 0.9999);
  assert.equal(fit.points, 5);
});

test("linear fit needs at least two measured points", () => {
  assert.equal(linearFit([{ speed: 10, periodMs: 500 }]).valid, false);
  assert.equal(linearFit([]).valid, false);
  assert.equal(linearFit([{ speed: 10, periodMs: 500 }, { speed: 10, periodMs: 480 }]).valid, false);
});

test("target rate maps through the fit and clamps to the firmware range", () => {
  const fit = { slope: -5.2, intercept: 1500, valid: true };
  assert.equal(speedForTargetBpm(fit, 200), 231); // period 300 ms -> (300-1500)/-5.2 = 230.77
  assert.equal(speedForTargetBpm(fit, 5), 0); // period 12 s -> clamped low
  assert.equal(speedForTargetBpm(fit, 5000), 255); // period 12 ms -> clamped high
  assert.equal(speedForTargetBpm({ ...fit, slope: 0 }, 60), null);
  assert.equal(speedForTargetBpm({ ...fit, valid: false }, 60), null);
  assert.equal(speedForTargetBpm(fit, 0), null);
  assert.equal(speedForTargetBpm(fit, -10), null);
  assert.equal(speedForTargetBpm(null, 60), null);
});

test("built-in formula inverts the piecewise model", () => {
  // Boundary and branch values of B(s): 617 @ 0, 12 @ 50, 3 @ 255.
  assert.equal(defaultSpeedForBpm(617), 0);
  assert.equal(defaultSpeedForBpm(700), 0);
  assert.equal(defaultSpeedForBpm(200), 8);
  assert.equal(defaultSpeedForBpm(60), 17);
  assert.equal(defaultSpeedForBpm(12), 50);
  assert.equal(defaultSpeedForBpm(10), 77);
  assert.equal(defaultSpeedForBpm(3), 255);
  assert.equal(defaultSpeedForBpm(1), 255);
  assert.equal(defaultSpeedForBpm(0), null);
  assert.equal(defaultSpeedForBpm(-5), null);
  assert.equal(defaultSpeedForBpm(null), null);
});

test("sweep step timeout floors fast rows and grows for slow blinks", () => {
  // Fast blinks get the floor; a 5 s period needs anchor + 5 cycles ≈ 32 s.
  assert.equal(stepTimeoutMs(1000), SWEEP_STEP_TIMEOUT_MIN_MS);
  assert.equal(stepTimeoutMs(5000), 47000);
  assert.equal(stepTimeoutMs(10000), 92000);
});

test("sweep measurement counts only valid periods after the anchor", () => {
  const measurement = createSweepMeasurement(3);
  assert.equal(measurement.done, false);
  assert.equal(measurement.addPeriod(null).done, false);
  assert.equal(measurement.addPeriod(100).done, false);
  assert.equal(measurement.addPeriod(100).done, false);
  const final = measurement.addPeriod(100);
  assert.equal(final.done, true);
  assert.equal(final.medianPeriodMs, 100);
});

test("camera support and error messages", () => {
  assert.ok(cameraSupportMessage(), "in Node there is no secure context, so a message is expected");
  assert.match(cameraErrorMessage({ name: "NotAllowedError" }), /permission/);
  assert.match(cameraErrorMessage({ name: "NotFoundError" }), /No camera/);
  assert.match(cameraErrorMessage({ name: "NotReadableError" }), /already in use/);
  assert.match(cameraErrorMessage({ name: "OverconstrainedError" }), /camera/i);
  assert.ok(cameraErrorMessage(new Error("boom")));
});
