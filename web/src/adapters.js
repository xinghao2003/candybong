const CANDYBONG_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CANDYBONG_COMMAND = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const CANDYBONG_RESPONSE = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

function hexToRgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new RangeError("Color must be a six-digit hex value");
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function staticColor(hex, brightness) {
  const [red, green, blue] = hexToRgb(hex);
  return new Uint8Array([0xff, 0xe6, 0x00, red, green, blue, integerInRange(brightness, 0, 10, "Brightness")]);
}

function colorEffect(opcode, speed, hex) {
  const [red, green, blue] = hexToRgb(hex);
  return new Uint8Array([0xff, opcode, 0x00, red, green, blue, integerInRange(speed, 0, 255, "Speed")]);
}

function fastColorFade(hex, speed) {
  return colorEffect(0xe2, speed, hex);
}

function slowColorFade(hex, speed) {
  return colorEffect(0xe3, speed, hex);
}

function randomColorBlink(speed) {
  return new Uint8Array([0xff, 0xe4, 0x00, 0x00, 0x00, 0x00, integerInRange(speed, 0, 255, "Speed")]);
}

function hueRotation(speed, hue) {
  return new Uint8Array([
    0xff,
    0xe7,
    integerInRange(speed, 0, 3, "Hue rotation speed"),
    integerInRange(hue, 0, 255, "Hue"),
  ]);
}

function builtInAnimation(animationId, speed) {
  return new Uint8Array([
    0xff,
    0x14,
    0x00,
    integerInRange(animationId, 1, 9, "Animation ID"),
    integerInRange(speed, 0, 255, "Speed"),
  ]);
}

function twiceColorShift(shift) {
  return new Uint8Array([0xff, 0x13, 0x00, integerInRange(shift, 1, 255, "Color shift")]);
}

function factoryColor(index) {
  return new Uint8Array([0xff, 0x15, 0x00, integerInRange(index, 0, 27, "Factory color index")]);
}

export function normalizedBlinkSpeed(speed) {
  const supplied = integerInRange(speed, 0, 255, "Speed");
  return Math.min(100, supplied < 95 ? supplied + 5 : supplied);
}

function timerTicks(value) {
  return Math.floor((value * 32768 + 1000) / 2000);
}

export function blinkRateForSpeed(speed) {
  const normalized = normalizedBlinkSpeed(speed);
  return 491520 / (normalized * timerTicks(normalized));
}

export function randomBlinkRateForSpeed(speed) {
  const normalized = normalizedBlinkSpeed(speed);
  return 163840 / timerTicks(normalized);
}

function speedForRate(targetBpm, rateForSpeed) {
  const target = Number(targetBpm);
  if (!Number.isFinite(target) || target <= 0) return null;
  let bestSpeed = 0;
  let bestError = Infinity;
  for (let speed = 0; speed <= 255; speed += 1) {
    const error = Math.abs(rateForSpeed(speed) - target);
    if (error < bestError) {
      bestSpeed = speed;
      bestError = error;
    }
  }
  return bestSpeed;
}

export function blinkSpeedForRate(targetBpm) {
  return speedForRate(targetBpm, blinkRateForSpeed);
}

export function randomBlinkSpeedForRate(targetBpm) {
  return speedForRate(targetBpm, randomBlinkRateForSpeed);
}

function suppliedSpeedForNormalized(normalized) {
  // u=5..99 can use the first occurrence; u=100 starts at supplied speed 100.
  return normalized === 100 ? 100 : normalized - 5;
}

function targetRateTiers(rateForSpeed) {
  return Array.from({ length: 96 }, (_, index) => {
    const normalized = index + 5;
    return rateForSpeed(suppliedSpeedForNormalized(normalized));
  });
}

// One target-rate tier for every usable normalized E1 value, u = 5..100.
// This preserves the complete effective firmware range while keeping the UI
// stepped. Duplicate raw-byte values are represented by the lowest byte that
// produces each timing, except for normalized u=100, whose first byte is 100.
const E1_TARGET_RATE_TIERS = targetRateTiers(blinkRateForSpeed);
const E4_TARGET_RATE_TIERS = targetRateTiers(randomBlinkRateForSpeed);

export const LIGHTSTICK_ADAPTERS = [
  {
    id: "twice-candybong-infinity",
    label: "TWICE Candybong Infinity",
    namePrefixes: ["TWICE LightStick"],
    serviceUuid: CANDYBONG_SERVICE,
    commandUuid: CANDYBONG_COMMAND,
    responseUuid: CANDYBONG_RESPONSE,
    customAnimations: {
      blink: {
        name: "Color blink",
        description: "Blink any RGB color at a target rate",
        usesColor: true,
        speed: { minimum: 0, maximum: 255, defaultValue: 12 },
        targetRate: {
          tiers: E1_TARGET_RATE_TIERS,
          defaultValue: 60,
        },
        previewEffect: "blink",
        packet: ({ color, speed }) => colorEffect(0xe1, speed, color),
      },
      pulse: {
        name: "Color pulse",
        description: "Fade any RGB color in and out",
        usesColor: true,
        speed: { minimum: 0, maximum: 255, defaultValue: 14 },
        previewEffect: "pulse",
        packet: ({ color, speed }) => fastColorFade(color, speed),
      },
      slowPulse: {
        name: "Slow color pulse",
        description: "A slower fade using any RGB color",
        usesColor: true,
        speed: { minimum: 0, maximum: 255, defaultValue: 12 },
        previewEffect: "pulse-slow",
        packet: ({ color, speed }) => slowColorFade(color, speed),
      },
      randomBlink: {
        name: "Random-color blink",
        description: "Let the lightstick choose each color",
        previewColor: "#c6a7ff",
        speed: { minimum: 0, maximum: 255, defaultValue: 12 },
        targetRate: {
          tiers: E4_TARGET_RATE_TIERS,
          defaultValue: randomBlinkRateForSpeed(12),
        },
        previewEffect: "rainbow-pulse",
        packet: ({ speed }) => randomColorBlink(speed),
      },
      hueSpin: {
        name: "Hue rotation",
        description: "Rotate colors from a selected starting hue",
        previewColor: "#c6a7ff",
        speed: { minimum: 0, maximum: 3, defaultValue: 3 },
        hue: { minimum: 0, maximum: 255, defaultValue: 16 },
        previewEffect: "rainbow",
        packet: ({ speed, hue }) => hueRotation(speed, hue),
      },
      builtIn: {
        name: "Built-in animation",
        description: "Run one of the nine firmware patterns",
        previewColor: "#8b6cff",
        speed: { minimum: 0, maximum: 255, defaultValue: 16 },
        animationId: { minimum: 1, maximum: 9, defaultValue: 1 },
        previewEffect: "pulse",
        packet: ({ speed, animationId }) => builtInAnimation(animationId, speed),
      },
      twiceShift: {
        name: "TWICE color shift",
        description: "Experimental firmware color-shift effect",
        previewColor: "#ff5fa2",
        colorShift: { minimum: 1, maximum: 255, defaultValue: 16 },
        previewEffect: "rainbow",
        experimental: true,
        packet: ({ colorShift }) => twiceColorShift(colorShift),
      },
    },
    scenes: {
      pink: {
        name: "Pink glow",
        description: "Gentle pink fade",
        color: "#ff5fa2",
        previewEffect: "pulse-slow",
        packet: () => slowColorFade("#ff5fa2", 12),
      },
      ocean: {
        name: "Ocean pulse",
        description: "Blue fade in and out",
        color: "#38c8ff",
        previewEffect: "pulse",
        packet: () => fastColorFade("#38c8ff", 14),
      },
      white: {
        name: "White pulse",
        description: "Slow white fade",
        color: "#ffffff",
        previewEffect: "pulse-slow",
        packet: () => slowColorFade("#ffffff", 12),
      },
      rainbow: {
        name: "Rainbow spin",
        description: "Rotating colors",
        color: "#c6a7ff",
        previewEffect: "rainbow",
        packet: () => new Uint8Array([0xff, 0xe7, 0x03, 0x10]),
      },
    },
    commands: {
      powerOn: () => new Uint8Array([0xff, 0x11]),
      powerOff: () => new Uint8Array([0xff, 0x12]),
      staticColor,
      factoryColor,
    },
  },
];

export function bluetoothRequestOptions() {
  return {
    filters: LIGHTSTICK_ADAPTERS.flatMap((adapter) => adapter.namePrefixes.map((namePrefix) => ({ namePrefix }))),
    optionalServices: [...new Set(LIGHTSTICK_ADAPTERS.map((adapter) => adapter.serviceUuid))],
  };
}

export function adapterForDevice(device) {
  return LIGHTSTICK_ADAPTERS.find((adapter) => adapter.namePrefixes.some((prefix) => device.name?.startsWith(prefix))) || null;
}
