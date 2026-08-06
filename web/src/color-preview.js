export function previewColor(r, g, b, brightness) {
  let w = 0;

  if (r === g && g === b && r !== 0) {
    w = r;
    r = 0;
    g = 0;
    b = 0;
  }

  if ((r || g || b) && w) {
    w = 0;
  }

  const rOut = brightness * Math.floor(r / 10);
  const gOut = brightness * Math.floor(g / 10);
  const bOut = brightness * Math.floor(b / 10);
  const wOut = brightness * Math.floor(w / 10);

  return {
    r: Math.min(255, rOut + wOut),
    g: Math.min(255, gOut + wOut),
    b: Math.min(255, bOut + wOut),
  };
}

function rgbFromHex(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export function previewColorFromHex(hex, brightness) {
  const input = rgbFromHex(hex);
  if (!input) return "#000000";
  const output = previewColor(input.r, input.g, input.b, brightness);
  return `#${[output.r, output.g, output.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function previewBackgroundFromHex(hex, brightness) {
  const input = rgbFromHex(hex);
  if (!input) return "#000000";

  if (input.r === input.g && input.g === input.b && input.r !== 0) {
    const whiteOutput = Math.min(255, brightness * Math.floor(input.r / 10));
    return `rgba(255,255,255,${whiteOutput / 255})`;
  }

  const output = previewColor(input.r, input.g, input.b, brightness);
  return `rgb(${output.r},${output.g},${output.b})`;
}
