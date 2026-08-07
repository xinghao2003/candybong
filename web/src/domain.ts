export type ConnectionStatus = "unsupported" | "idle" | "requesting" | "connecting" | "connected" | "error";
export type AppTab = "controller" | "tools" | "device";
export type ToolId = "studio" | "latency";
export type DiagnosticDirection = "TX" | "RX" | "SYS" | "WARN" | "ERR";

export interface AnimationDefinition {
  name: string;
  description: string;
  usesColor?: boolean;
  previewColor?: string;
  previewEffect: string;
  experimental?: boolean;
  speed?: { minimum: number; maximum: number; defaultValue: number };
  targetRate?: { tiers: number[]; defaultValue: number };
  hue?: { minimum: number; maximum: number; defaultValue: number };
  animationId?: { minimum: number; maximum: number; defaultValue: number };
  colorShift?: { minimum: number; maximum: number; defaultValue: number };
  packet(parameters: AnimationParameters): Uint8Array;
}

export interface AnimationParameters {
  color: string;
  speed: number;
  hue: number;
  animationId: number;
  colorShift: number;
}

export interface SceneDefinition {
  name: string;
  description: string;
  color: string;
  previewEffect: string;
  packet(): Uint8Array;
}

export interface LightstickAdapter {
  id: string;
  label: string;
  namePrefixes: string[];
  serviceUuid: BluetoothServiceUUID;
  commandUuid: BluetoothCharacteristicUUID;
  responseUuid: BluetoothCharacteristicUUID;
  customAnimations: Record<string, AnimationDefinition>;
  scenes: Record<string, SceneDefinition>;
  commands: {
    powerOn(): Uint8Array;
    powerOff(): Uint8Array;
    staticColor(color: string, brightness: number): Uint8Array;
    factoryColor(index: number): Uint8Array;
  };
}

export interface DiagnosticEntry {
  id: number;
  at: number;
  direction: DiagnosticDirection;
  label: string;
  bytes?: number[];
}

export interface SessionSnapshot {
  status: ConnectionStatus;
  supportMessage: string;
  errorMessage: string;
  deviceName: string;
  adapter: LightstickAdapter | null;
  connectedAt: number | null;
  transportLatencyMs: number | null;
  batteryLevel: number | null;
  batteryStatusCode: number | null;
  writeWithResponse: boolean;
  writeWithoutResponse: boolean;
  responseStatus: "unavailable" | "listening";
  isMock: boolean;
  sending: boolean;
  diagnostics: DiagnosticEntry[];
}

export interface ControllerState {
  color: string;
  brightness: number;
  poweredOff: boolean;
  activeScene: string | null;
  activeAnimation: string | null;
  previewColor: string;
  previewEffect: string;
  previewName: string;
  previewDescription: string;
  lastCommand: string;
}

export function packetLabel(packet: Uint8Array | number[]): string {
  return [...packet].map((byte) => byte.toString(16).padStart(2, "0")).join(" ").toUpperCase();
}

/**
 * FF 16 battery grade (0x01..0x11) → approximate percentage, or null when the
 * grade has no percentage (0x20 = no sample yet). The firmware's 17 grades are
 * a nearly-linear voltage ladder from ~2.85 V (grade 1) to ~4.4 V at the cell
 * (grade 0x11, above a normal 4.2 V full charge — so a fully charged stick
 * usually reports 0x10, ≈94%). It is an approximation of remaining voltage
 * headroom, not a capacity measurement.
 */
export function batteryPercentageFromStatusCode(code: number): number | null {
  if (code === 0x20) return null;
  return Math.round(((code - 0x01) * 100) / 0x10);
}
