import { describe, expect, it } from "vitest";
import { previewBackgroundFromHex, previewColor, previewColorFromHex } from "../src/color-preview.js";

describe("Candybong RGBW preview conversion", () => {
  it("routes equal nonzero RGB through the white channel", () => {
    expect(previewColor(255, 255, 255, 10)).toEqual({ r: 250, g: 250, b: 250 });
  });

  it("quantizes mixed RGB channels at the selected brightness", () => {
    expect(previewColorFromHex("#ff5fa2", 10)).toBe("#fa5aa0");
    expect(previewColorFromHex("#ff5fa2", 8)).toBe("#c84880");
    expect(previewBackgroundFromHex("#ff5fa2", 10)).toBe("rgb(250,90,160)");
  });

  it("renders white-channel output as dim white instead of gray RGB", () => {
    expect(previewBackgroundFromHex("#4b4b4b", 10)).toBe("rgba(255,255,255,0.27450980392156865)");
  });

  it("renders zero brightness as black", () => {
    expect(previewColorFromHex("#ffffff", 0)).toBe("#000000");
  });
});
