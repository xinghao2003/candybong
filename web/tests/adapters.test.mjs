import { describe, expect, it } from "vitest";
import {
  blinkRateForSpeed,
  blinkSpeedForRate,
  normalizedBlinkSpeed,
  randomBlinkRateForSpeed,
  randomBlinkSpeedForRate,
} from "../src/adapters.js";

const DISTINCT_SPEEDS = [...Array.from({ length: 95 }, (_, speed) => speed), 100];

describe("firmware blink-rate abstraction", () => {
  it("matches the documented E1/E4 speed normalization", () => {
    expect(normalizedBlinkSpeed(0)).toBe(5);
    expect(normalizedBlinkSpeed(94)).toBe(99);
    expect(normalizedBlinkSpeed(95)).toBe(95);
    expect(normalizedBlinkSpeed(99)).toBe(99);
    expect(normalizedBlinkSpeed(100)).toBe(100);
    expect(normalizedBlinkSpeed(255)).toBe(100);
  });

  it("round-trips every distinct E1 timing through a target rate", () => {
    for (const speed of DISTINCT_SPEEDS) {
      expect(blinkSpeedForRate(blinkRateForSpeed(speed))).toBe(speed);
    }
  });

  it("round-trips every distinct E4 timing through a target rate", () => {
    for (const speed of DISTINCT_SPEEDS) {
      expect(randomBlinkSpeedForRate(randomBlinkRateForSpeed(speed))).toBe(speed);
    }
  });
});
