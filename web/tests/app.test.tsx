import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { BluetoothSessionProvider, BluetoothSessionStore } from "../src/bluetooth-session";

class FakeCharacteristic extends EventTarget {
  properties = { write: true, writeWithoutResponse: false, notify: true, indicate: false };
  value: DataView | undefined;
  writes: number[][] = [];
  async writeValueWithResponse(value: BufferSource) {
    this.writes.push([...new Uint8Array(value as ArrayBuffer)]);
  }
  async writeValueWithoutResponse(value: BufferSource) { await this.writeValueWithResponse(value); }
  async writeValue(value: BufferSource) { await this.writeValueWithResponse(value); }
  async startNotifications() { return this; }
  async stopNotifications() { return this; }
}

function installBluetooth() {
  const command = new FakeCharacteristic();
  const response = new FakeCharacteristic();
  const device = new EventTarget() as EventTarget & { name: string; gatt: { connected: boolean; connect(): Promise<any>; disconnect(): void } };
  const service = { getCharacteristic: vi.fn(async (uuid: string) => uuid.includes("0002") ? command : response) };
  const server = { getPrimaryService: vi.fn(async () => service) };
  device.name = "TWICE LightStick Test";
  device.gatt = {
    connected: true,
    connect: vi.fn(async () => server),
    disconnect() { this.connected = false; device.dispatchEvent(new Event("gattserverdisconnected")); },
  };
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: vi.fn(async () => device) } });
  return { command, device };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  window.history.replaceState(null, "", "/#controller");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => cleanup());

describe("connection-gated app", () => {
  test("toggles and persists the color theme", () => {
    installBluetooth();
    render(<BluetoothSessionProvider><App /></BluetoothSessionProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("candybong-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeTruthy();
  });

  test("renders only the connection gate before Bluetooth is ready", () => {
    installBluetooth();
    render(<BluetoothSessionProvider><App /></BluetoothSessionProvider>);
    expect(screen.getByRole("heading", { name: "Connect your Candybong" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Controller" })).toBeNull();
  });

  test("enters Controller after connecting and returns to the gate on disconnect", async () => {
    const { command } = installBluetooth();
    render(<BluetoothSessionProvider><App /></BluetoothSessionProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Connect with Bluetooth/i }));
    await screen.findByRole("heading", { name: "Make it yours." });
    expect(screen.getByRole("tab", { name: "Controller" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(command.writes).toContainEqual([0xff, 0x11]));
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    await waitFor(() => expect(window.location.hash).toBe("#tools"));
    expect(screen.getByRole("tab", { name: "Tools" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Candybong" }));
    await screen.findByRole("heading", { name: "Connect your Candybong" });
  });

  test("enters through the development mock and simulates a disconnect", async () => {
    Reflect.deleteProperty(navigator, "bluetooth");
    render(<BluetoothSessionProvider><App /></BluetoothSessionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Use mock Candybong" }));
    await screen.findByRole("heading", { name: "Make it yours." });

    fireEvent.click(screen.getByRole("tab", { name: "Device" }));
    expect(await screen.findByText("Mock device")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Emit response" }));
    expect(await screen.findByText("Simulated device response")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Simulate disconnect" }));
    await screen.findByRole("heading", { name: "Connect your Candybong" });
    expect(screen.getByRole("button", { name: /Connect with Bluetooth/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Use mock Candybong" }).hasAttribute("disabled")).toBe(false);
  });
});

test("BluetoothSessionStore serializes writes and records diagnostics", async () => {
  const { command } = installBluetooth();
  const store = new BluetoothSessionStore();
  await store.connect();
  await act(async () => {
    await Promise.all([
      store.sendCommand(new Uint8Array([0xff, 0x11]), "Power on"),
      store.sendCommand(new Uint8Array([0xff, 0x12]), "Power off"),
    ]);
  });
  expect(command.writes).toEqual([[0xff, 0x11], [0xff, 0x12]]);
  await waitFor(() => expect(store.getSnapshot().sending).toBe(false));
  expect(store.getSnapshot().diagnostics.some((entry) => entry.label === "Power on")).toBe(true);
  store.destroy();
});

test("BluetoothSessionStore supports mock writes and an injected failure", async () => {
  const store = new BluetoothSessionStore();
  expect(await store.connectMock()).toBe(true);
  expect(store.getSnapshot().isMock).toBe(true);

  await store.sendCommand(new Uint8Array([0xff, 0x11]), "Mock power on");
  expect(store.getSnapshot().diagnostics.some((entry) => entry.label === "Mock acknowledgement")).toBe(true);

  store.failNextMockCommand();
  await expect(store.sendCommand(new Uint8Array([0xff, 0x12]), "Mock power off")).rejects.toThrow("Simulated Bluetooth write failure");
  expect(store.getSnapshot().diagnostics.some((entry) => entry.direction === "ERR")).toBe(true);
  store.destroy();
});

test("BluetoothSessionStore exposes unsupported and cancelled connection states", async () => {
    Reflect.deleteProperty(navigator, "bluetooth");
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false });
  const unsupported = new BluetoothSessionStore();
  expect(unsupported.getSnapshot().status).toBe("unsupported");
  unsupported.destroy();

  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: { requestDevice: vi.fn(async () => { throw new DOMException("cancelled", "NotFoundError"); }) },
  });
  const cancelled = new BluetoothSessionStore();
  expect(await cancelled.connect()).toBe(false);
  expect(cancelled.getSnapshot().status).toBe("error");
  expect(cancelled.getSnapshot().errorMessage).toMatch(/No Candybong selected/);
  cancelled.destroy();
});
