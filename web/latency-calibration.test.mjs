import test from "node:test";
import assert from "node:assert/strict";
import { LIGHTSTICK_ADAPTERS } from "./adapters.js";
import {
  CALIBRATION_MIN_VALID_TRIALS,
  CALIBRATION_REPLY_PREFIX,
  buildCalibrationReport,
  createAudioImpulseDetector,
  createCalibrationProfiles,
  createLumaChangeDetector,
  percentile,
  rms,
  summarizeCalibrationProfile,
} from "./latency-calibration.js";

test("calibration profiles cover the safe command families", () => {
  const profiles = createCalibrationProfiles(LIGHTSTICK_ADAPTERS[0]);
  assert.equal(profiles.length, 18);
  assert.deepEqual([...profiles[0].packet], [0xff, 0x15, 0x00, 0x00]);
  assert.deepEqual(profiles[0].expectedResponse, CALIBRATION_REPLY_PREFIX);
  assert.equal(profiles.find((profile) => profile.id === "off.ff12").direction, "fall");
  assert.equal(profiles.filter((profile) => profile.id.startsWith("builtIn.")).length, 9);
  assert.equal(profiles.find((profile) => profile.id === "builtIn.3").direction, "fall");
  assert.equal(profiles.find((profile) => profile.id === "builtIn.7").direction, "fall");
  assert.equal(profiles.find((profile) => profile.id === "twiceShift.e13").includeInGlobal, false);
});

test("audio impulse detector ignores baseline noise and reports one click", () => {
  const detector = createAudioImpulseDetector({ minRms: 0.01, confirmMs: 10 });
  detector.arm();
  for (let time = 0; time < 100; time += 10) assert.equal(detector.step(0.002, time).edge, null);
  assert.equal(detector.step(0.2, 110).edge, null);
  const result = detector.step(0.2, 125);
  assert.equal(result.edge, "rise");
  assert.equal(result.edgeAt, 110);
  assert.equal(detector.step(0.2, 140).edge, null);
});

test("luma change detector reports a sustained change once", () => {
  const detector = createLumaChangeDetector({ minDelta: 8, confirmMs: 20 });
  detector.arm(40);
  assert.equal(detector.step(44, 0).edge, null);
  assert.equal(detector.step(55, 10).edge, null);
  assert.equal(detector.step(55, 35).edge, "change");
  assert.equal(detector.step(20, 50).edge, null);
});

test("calibration statistics use valid samples and maximum family p95", () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  assert.equal(rms(new Float32Array([3, 4])), 3.5355339059327378);

  const definition = {
    id: "solid",
    label: "Solid",
    packet: new Uint8Array([0xff, 0xe6]),
    direction: "rise",
    includeInGlobal: true,
  };
  const trials = Array.from({ length: CALIBRATION_MIN_VALID_TRIALS }, (_, index) => ({
    valid: true,
    soundToLightMs: 40 + index,
    commandToLightMs: 50 + index,
    writeMs: 5,
    replyMs: null,
  }));
  trials.push({ valid: false, soundToLightMs: null, commandToLightMs: null, writeMs: null, replyMs: null });
  const summary = summarizeCalibrationProfile(definition, trials);
  assert.equal(summary.validCount, CALIBRATION_MIN_VALID_TRIALS);
  assert.equal(summary.invalidCount, 1);
  assert.equal(summary.eligibleForGlobal, true);

  const slowDefinition = { ...definition, id: "slow", label: "Slow", packet: new Uint8Array([0xff, 0xe2]) };
  const slowTrials = Array.from({ length: CALIBRATION_MIN_VALID_TRIALS }, () => ({
    valid: true,
    soundToLightMs: 87,
    commandToLightMs: 90,
    writeMs: 6,
    replyMs: null,
  }));
  const report = buildCalibrationReport({
    profiles: [definition, slowDefinition],
    trialsByProfile: { solid: trials, slow: slowTrials },
    metadata: { test: true },
  });
  assert.equal(report.global.statistic, "maximum-family-p95");
  assert.equal(report.global.globalP95SoundToLightMs, 87);
  assert.equal(report.global.recommendedCueOffsetMs, 90);
  assert.deepEqual(report.metadata, { test: true });
});
