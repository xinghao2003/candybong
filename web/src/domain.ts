export type ConnectionStatus = "unsupported" | "idle" | "requesting" | "connecting" | "connected" | "error";
export type AppTab = "controller" | "tools" | "device";
export type ToolId = "studio" | "palette" | "latency" | "blink" | "capture";
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
