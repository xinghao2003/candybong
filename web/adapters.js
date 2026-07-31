const CANDYBONG_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CANDYBONG_COMMAND = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function staticColor(hex, brightness) {
  const [red, green, blue] = hexToRgb(hex);
  return new Uint8Array([0xff, 0xe6, 0x00, red, green, blue, brightness]);
}

function colorEffect(opcode, speed, hex) {
  const [red, green, blue] = hexToRgb(hex);
  return new Uint8Array([0xff, opcode, 0x00, red, green, blue, speed]);
}

function fastColorFade(hex, speed) {
  return colorEffect(0xe2, speed, hex);
}

function slowColorFade(hex, speed) {
  return colorEffect(0xe3, speed, hex);
}

export const LIGHTSTICK_ADAPTERS = [
  {
    id: "twice-candybong-infinity",
    label: "TWICE Candybong Infinity",
    namePrefixes: ["TWICE LightStick"],
    serviceUuid: CANDYBONG_SERVICE,
    commandUuid: CANDYBONG_COMMAND,
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
