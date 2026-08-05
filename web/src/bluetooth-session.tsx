import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { adapterForDevice, bluetoothRequestOptions, LIGHTSTICK_ADAPTERS } from "./adapters.js";
import type { DiagnosticEntry, DiagnosticDirection, LightstickAdapter, SessionSnapshot } from "./domain";

const MAX_DIAGNOSTICS = 100;

function supportMessage(): string {
  if (globalThis.isSecureContext === false) return "Bluetooth requires HTTPS or localhost.";
  if (!("bluetooth" in navigator)) return "Web Bluetooth is not supported by this browser.";
  return "Web Bluetooth ready · Nordic UART profile";
}

function initialSnapshot(): SessionSnapshot {
  const support = supportMessage();
  return {
    status: support.startsWith("Web Bluetooth ready") ? "idle" : "unsupported",
    supportMessage: support,
    errorMessage: "",
    deviceName: "",
    adapter: null,
    connectedAt: null,
    writeWithResponse: false,
    writeWithoutResponse: false,
    responseStatus: "unavailable",
    isMock: false,
    sending: false,
    diagnostics: [],
  };
}

export class BluetoothSessionStore {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private device: BluetoothDevice | null = null;
  private commandCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private responseCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private diagnosticId = 0;
  private pendingWrites = 0;
  private failNextMockWrite = false;

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  addDiagnostic(direction: DiagnosticDirection, label: string, packet?: Uint8Array | number[]): void {
    const entry: DiagnosticEntry = {
      id: ++this.diagnosticId,
      at: Date.now(),
      direction,
      label,
      bytes: packet ? [...packet] : undefined,
    };
    this.publish({ diagnostics: [entry, ...this.snapshot.diagnostics].slice(0, MAX_DIAGNOSTICS) });
  }

  clearDiagnostics = (): void => this.publish({ diagnostics: [] });

  connect = async (): Promise<boolean> => {
    if (this.snapshot.status === "unsupported") return false;
    if (this.snapshot.status === "connected") return true;

    this.publish({ status: "requesting", errorMessage: "" });
    try {
      const bluetooth = navigator.bluetooth;
      const device = await bluetooth.requestDevice(bluetoothRequestOptions());
      const adapter = adapterForDevice(device) as LightstickAdapter | null;
      if (!adapter) throw new Error("The selected device has no supported Candybong profile.");

      this.publish({ status: "connecting", deviceName: device.name || adapter.label, adapter });
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.handleGattDisconnected);
      const server = await device.gatt?.connect();
      if (!server) throw new Error("The Candybong did not expose a GATT server.");
      const service = await server.getPrimaryService(adapter.serviceUuid);
      const commandCharacteristic = await service.getCharacteristic(adapter.commandUuid);
      this.commandCharacteristic = commandCharacteristic;

      let responseStatus: SessionSnapshot["responseStatus"] = "unavailable";
      try {
        const response = await service.getCharacteristic(adapter.responseUuid);
        if ((response.properties.notify || response.properties.indicate) && response.startNotifications) {
          await response.startNotifications();
          response.addEventListener("characteristicvaluechanged", this.handleResponse);
          this.responseCharacteristic = response;
          responseStatus = "listening";
          this.addDiagnostic("SYS", "Response notifications enabled");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Response notifications unavailable";
        this.addDiagnostic("WARN", message);
      }

      this.publish({
        status: "connected",
        errorMessage: "",
        deviceName: device.name || adapter.label,
        adapter,
        connectedAt: Date.now(),
        writeWithResponse: Boolean(commandCharacteristic.properties.write),
        writeWithoutResponse: Boolean(commandCharacteristic.properties.writeWithoutResponse),
        responseStatus,
      });
      this.addDiagnostic("SYS", `Connected to ${device.name || adapter.label}`);
      return true;
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "NotFoundError";
      const message = cancelled
        ? "No Candybong selected. Tap connect when you are ready."
        : error instanceof Error ? error.message : "The Candybong could not be connected.";
      this.releaseConnection(false);
      this.publish({
        status: "error",
        errorMessage: message,
        deviceName: "",
        adapter: null,
        connectedAt: null,
      });
      if (!cancelled) this.addDiagnostic("ERR", `Connection failed: ${message}`);
      return false;
    }
  };

  connectMock = async (): Promise<boolean> => {
    if (!import.meta.env.DEV) return false;
    if (this.snapshot.status === "connected" && this.snapshot.isMock) return true;
    const adapter = LIGHTSTICK_ADAPTERS[0] as LightstickAdapter | undefined;
    if (!adapter) return false;

    this.releaseConnection(false);
    this.publish({ status: "requesting", errorMessage: "", supportMessage: "Development mock device" });
    await Promise.resolve();
    this.publish({ status: "connecting", deviceName: "Mock TWICE LightStick", adapter });
    await Promise.resolve();
    this.publish({
      status: "connected",
      errorMessage: "",
      deviceName: "Mock TWICE LightStick",
      adapter,
      connectedAt: Date.now(),
      writeWithResponse: true,
      writeWithoutResponse: false,
      responseStatus: "listening",
      isMock: true,
    });
    this.addDiagnostic("SYS", "Connected to development mock Candybong");
    return true;
  };

  disconnect = (): void => {
    if (this.snapshot.isMock) {
      this.addDiagnostic("SYS", "Mock Candybong disconnected");
      this.releaseConnection(true);
      return;
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.releaseConnection(true);
  };

  emitMockResponse = (): void => {
    if (!import.meta.env.DEV || !this.snapshot.isMock) return;
    this.addDiagnostic("RX", "Simulated device response", [0xac, 0x01]);
  };

  failNextMockCommand = (): void => {
    if (!import.meta.env.DEV || !this.snapshot.isMock) return;
    this.failNextMockWrite = true;
    this.addDiagnostic("WARN", "Next mock command will fail");
  };

  simulateMockDisconnect = (): void => {
    if (!import.meta.env.DEV || !this.snapshot.isMock) return;
    this.addDiagnostic("SYS", "Simulated connection loss");
    this.releaseConnection(true);
  };

  sendCommand = (packet: Uint8Array, label: string): Promise<void> => {
    const generation = this.generation;
    const run = this.writeQueue.catch(() => undefined).then(async () => {
      const isMock = import.meta.env.DEV && this.snapshot.isMock;
      if (generation !== this.generation || (!isMock && !this.commandCharacteristic) || this.snapshot.status !== "connected") {
        throw new Error("The Candybong is not connected.");
      }
      this.pendingWrites += 1;
      this.publish({ sending: true });
      this.addDiagnostic("TX", label, packet);
      const characteristic = this.commandCharacteristic;
      try {
        if (isMock) {
          await new Promise((resolve) => window.setTimeout(resolve, 35));
          if (this.failNextMockWrite) {
            this.failNextMockWrite = false;
            throw new Error("Simulated Bluetooth write failure");
          }
          this.addDiagnostic("RX", "Mock acknowledgement", [0xac, packet[1] ?? 0x00]);
        } else if (characteristic?.properties.write && characteristic.writeValueWithResponse) {
          await characteristic.writeValueWithResponse(packet as unknown as BufferSource);
        } else if (characteristic?.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
          await characteristic.writeValueWithoutResponse(packet as unknown as BufferSource);
        } else if (characteristic?.writeValueWithResponse) {
          await characteristic.writeValueWithResponse(packet as unknown as BufferSource);
        } else if (characteristic) {
          await characteristic.writeValue(packet as unknown as BufferSource);
        } else {
          throw new Error("The Candybong command characteristic is unavailable.");
        }
        if (generation !== this.generation || this.snapshot.status !== "connected") {
          throw new Error("The Bluetooth session ended during the write.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bluetooth write failed";
        this.addDiagnostic("ERR", `${label} failed: ${message}`);
        throw error;
      } finally {
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
        this.publish({ sending: this.pendingWrites > 0 });
      }
    });
    this.writeQueue = run;
    return run;
  };

  destroy(): void {
    this.releaseConnection(false);
    this.listeners.clear();
  }

  private readonly handleResponse = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic | null;
    const value = characteristic?.value;
    if (!value) return;
    this.addDiagnostic("RX", "Device response", new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  };

  private readonly handleGattDisconnected = (): void => {
    this.addDiagnostic("SYS", "Candybong disconnected");
    this.releaseConnection(true);
  };

  private releaseConnection(publishIdle: boolean): void {
    this.generation += 1;
    this.pendingWrites = 0;
    if (this.responseCharacteristic) {
      this.responseCharacteristic.removeEventListener("characteristicvaluechanged", this.handleResponse);
      void this.responseCharacteristic.stopNotifications?.().catch(() => undefined);
    }
    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.handleGattDisconnected);
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    }
    this.responseCharacteristic = null;
    this.commandCharacteristic = null;
    this.device = null;
    this.writeQueue = Promise.resolve();
    this.failNextMockWrite = false;
    if (publishIdle) {
      const support = supportMessage();
      this.publish({
        status: support.startsWith("Web Bluetooth ready") ? "idle" : "unsupported",
        supportMessage: support,
        errorMessage: "",
        deviceName: "",
        adapter: null,
        connectedAt: null,
        writeWithResponse: false,
        writeWithoutResponse: false,
        responseStatus: "unavailable",
        isMock: false,
        sending: false,
      });
    }
  }
}

interface BluetoothSessionValue {
  snapshot: SessionSnapshot;
  connect(): Promise<boolean>;
  connectMock(): Promise<boolean>;
  disconnect(): void;
  sendCommand(packet: Uint8Array, label: string): Promise<void>;
  addDiagnostic(direction: DiagnosticDirection, label: string, packet?: Uint8Array | number[]): void;
  clearDiagnostics(): void;
  emitMockResponse(): void;
  failNextMockCommand(): void;
  simulateMockDisconnect(): void;
}

const BluetoothSessionContext = createContext<BluetoothSessionStore | null>(null);

export function BluetoothSessionProvider({ children }: PropsWithChildren) {
  const storeRef = useRef<BluetoothSessionStore | null>(null);
  if (!storeRef.current) storeRef.current = new BluetoothSessionStore();
  useEffect(() => {
    const store = storeRef.current;
    return () => store?.destroy();
  }, []);
  return <BluetoothSessionContext value={storeRef.current}>{children}</BluetoothSessionContext>;
}

export function useBluetoothSession(): BluetoothSessionValue {
  const store = useContext(BluetoothSessionContext);
  if (!store) throw new Error("BluetoothSessionProvider is missing");
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    snapshot,
    connect: store.connect,
    connectMock: store.connectMock,
    disconnect: store.disconnect,
    sendCommand: store.sendCommand,
    addDiagnostic: store.addDiagnostic.bind(store),
    clearDiagnostics: store.clearDiagnostics,
    emitMockResponse: store.emitMockResponse,
    failNextMockCommand: store.failNextMockCommand,
    simulateMockDisconnect: store.simulateMockDisconnect,
  };
}
