import { LIGHTSTICK_ADAPTERS, adapterForDevice, bluetoothRequestOptions } from "./adapters.js";

const defaultAdapter = LIGHTSTICK_ADAPTERS[0];
const FACTORY_PALETTE_STORAGE_KEY = "candybong-factory-palette-v1";
const MAX_DIAGNOSTIC_ENTRIES = 100;
const animationSettings = Object.fromEntries(
  Object.entries(defaultAdapter.customAnimations).map(([mode, definition]) => [
    mode,
    {
      speed: definition.speed?.defaultValue,
      hue: definition.hue?.defaultValue,
      animationId: definition.animationId?.defaultValue,
      colorShift: definition.colorShift?.defaultValue,
    },
  ]),
);

const state = {
  adapter: null,
  device: null,
  characteristic: null,
  responseCharacteristic: null,
  color: "#ff5fa2",
  brightness: 10,
  activeScene: null,
  activeCustomAnimation: null,
  animationMode: "pulse",
  animationSettings,
  selectedFactoryIndex: 0,
  activeFactoryIndex: null,
  factoryPalette: {},
  diagnostics: [],
  poweredOff: false,
  sending: false,
};

const elements = {
  connectButton: document.querySelector("#connectButton"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  connectionTitle: document.querySelector("#connectionTitle"),
  connectionMessage: document.querySelector("#connectionMessage"),
  supportNote: document.querySelector("#supportNote"),
  lightstickVisual: document.querySelector("#lightstickVisual"),
  previewMode: document.querySelector("#previewMode"),
  previewName: document.querySelector("#previewName"),
  previewDescription: document.querySelector("#previewDescription"),
  hexValue: document.querySelector("#hexValue"),
  colorInput: document.querySelector("#colorInput"),
  colorSwatch: document.querySelector("#colorSwatch"),
  colorPresets: [...document.querySelectorAll("[data-color]")],
  brightnessInput: document.querySelector("#brightnessInput"),
  brightnessValue: document.querySelector("#brightnessValue"),
  commandStatus: document.querySelector(".command-status"),
  lastCommand: document.querySelector("#lastCommand"),
  onButton: document.querySelector("#onButton"),
  offButton: document.querySelector("#offButton"),
  applyColorButton: document.querySelector("#applyColorButton"),
  animationMode: document.querySelector("#animationMode"),
  animationColorField: document.querySelector("#animationColorField"),
  animationColorInput: document.querySelector("#animationColorInput"),
  animationColorSwatch: document.querySelector("#animationColorSwatch"),
  animationColorValue: document.querySelector("#animationColorValue"),
  animationSpeedField: document.querySelector("#animationSpeedField"),
  animationSpeedInput: document.querySelector("#animationSpeedInput"),
  animationSpeedValue: document.querySelector("#animationSpeedValue"),
  animationHueField: document.querySelector("#animationHueField"),
  animationHueInput: document.querySelector("#animationHueInput"),
  animationHueValue: document.querySelector("#animationHueValue"),
  animationIdField: document.querySelector("#animationIdField"),
  animationIdInput: document.querySelector("#animationIdInput"),
  animationIdValue: document.querySelector("#animationIdValue"),
  colorShiftField: document.querySelector("#colorShiftField"),
  colorShiftInput: document.querySelector("#colorShiftInput"),
  colorShiftValue: document.querySelector("#colorShiftValue"),
  applyAnimationButton: document.querySelector("#applyAnimationButton"),
  animationSummarySwatch: document.querySelector("#animationSummarySwatch"),
  animationSummaryName: document.querySelector("#animationSummaryName"),
  animationSummaryDescription: document.querySelector("#animationSummaryDescription"),
  animationPacketPreview: document.querySelector("#animationPacketPreview"),
  factoryPaletteGrid: document.querySelector("#factoryPaletteGrid"),
  factoryPaletteProgress: document.querySelector("#factoryPaletteProgress"),
  factorySelectionName: document.querySelector("#factorySelectionName"),
  factoryPacketPreview: document.querySelector("#factoryPacketPreview"),
  factoryColorLabel: document.querySelector("#factoryColorLabel"),
  testFactoryColorButton: document.querySelector("#testFactoryColorButton"),
  saveFactoryLabelButton: document.querySelector("#saveFactoryLabelButton"),
  clearFactoryResultButton: document.querySelector("#clearFactoryResultButton"),
  responseStatus: document.querySelector("#responseStatus"),
  diagnosticLog: document.querySelector("#diagnosticLog"),
  diagnosticEmpty: document.querySelector("#diagnosticEmpty"),
  clearDiagnosticsButton: document.querySelector("#clearDiagnosticsButton"),
  sceneButtons: [...document.querySelectorAll("[data-scene]")],
  toast: document.querySelector("#toast"),
};

function isConnected() {
  return Boolean(state.characteristic && state.device?.gatt?.connected);
}

function setControlsDisabled(disabled) {
  elements.onButton.disabled = disabled;
  elements.offButton.disabled = disabled;
  elements.applyColorButton.disabled = disabled;
  elements.applyAnimationButton.disabled = disabled;
  elements.testFactoryColorButton.disabled = disabled;
  elements.sceneButtons.forEach((button) => { button.disabled = disabled; });
}

function setConnectionStatus(connected, message = "") {
  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionLabel.textContent = connected ? "Connected" : "Disconnected";
  elements.connectionTitle.textContent = connected
    ? (state.device?.name || state.adapter?.label || "Lightstick connected")
    : "Connect your lightstick";
  elements.connectionMessage.textContent = connected
    ? "Ready. Choose a color or animated effect below."
    : message || "Turn on your Candybong and keep it nearby.";
  elements.connectButton.textContent = connected ? "Disconnect" : "Connect Bluetooth";
  setControlsDisabled(!connected || state.sending);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function setCommandStatus(status, message) {
  elements.commandStatus.classList.remove("success", "sending", "error");
  if (status) elements.commandStatus.classList.add(status);
  elements.lastCommand.textContent = message;
}

function packetLabel(packet) {
  return [...packet].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function renderDiagnostics() {
  elements.diagnosticLog.replaceChildren();

  if (state.diagnostics.length === 0) {
    const empty = document.createElement("li");
    empty.className = "diagnostic-empty";
    empty.textContent = "No packets recorded yet.";
    elements.diagnosticLog.append(empty);
    return;
  }

  state.diagnostics.forEach((entry) => {
    const item = document.createElement("li");
    item.className = `diagnostic-entry ${entry.kind}`;

    const time = document.createElement("span");
    time.className = "diagnostic-time";
    time.textContent = entry.time;

    const direction = document.createElement("span");
    direction.className = "diagnostic-direction";
    direction.textContent = entry.direction;

    const message = document.createElement("span");
    message.className = "diagnostic-message";
    const label = document.createElement("strong");
    label.textContent = entry.label;
    message.append(label);
    if (entry.packet) {
      const packet = document.createElement("code");
      packet.textContent = entry.packet;
      message.append(packet);
    }

    item.append(time, direction, message);
    elements.diagnosticLog.append(item);
  });

  elements.diagnosticLog.scrollTop = elements.diagnosticLog.scrollHeight;
}

function addDiagnostic(direction, label, packet = null, kind = "status") {
  const now = new Date();
  state.diagnostics.push({
    time: now.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    direction,
    label,
    packet: packet ? packetLabel(packet).toUpperCase() : null,
    kind,
  });
  if (state.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) state.diagnostics.shift();
  renderDiagnostics();
}

function setResponseStatus(message, style = null) {
  elements.responseStatus.textContent = message;
  elements.responseStatus.classList.remove("listening", "warning");
  if (style) elements.responseStatus.classList.add(style);
}

function activeAdapter() {
  return state.adapter || defaultAdapter;
}

function currentAnimationDefinition() {
  return activeAdapter().customAnimations[state.animationMode];
}

function currentAnimationSettings() {
  return state.animationSettings[state.animationMode];
}

function currentAnimationParameters() {
  return {
    color: state.color,
    ...currentAnimationSettings(),
  };
}

function setRangeControl(input, output, range, value) {
  if (!range) return;
  input.min = String(range.minimum);
  input.max = String(range.maximum);
  input.value = String(value);
  const progress = ((value - range.minimum) / (range.maximum - range.minimum)) * 100;
  input.style.setProperty("--progress", `${progress}%`);
  output.textContent = `${value} / ${range.maximum}`;
}

function customAnimationDescription(definition, settings) {
  if (definition.usesColor) return `${definition.description} · speed ${settings.speed}`;
  if (definition.hue) return `Starting hue ${settings.hue} · speed ${settings.speed}`;
  if (definition.animationId) return `Pattern ${settings.animationId} · speed ${settings.speed}`;
  if (definition.colorShift) return `Shift value ${settings.colorShift} · experimental`;
  return definition.description;
}

function updateAnimationBuilder() {
  const definition = currentAnimationDefinition();
  const settings = currentAnimationSettings();
  const color = state.color.toUpperCase();
  const previewColor = definition.usesColor ? color : definition.previewColor;

  elements.animationMode.value = state.animationMode;
  elements.animationColorField.hidden = !definition.usesColor;
  elements.animationSpeedField.hidden = !definition.speed;
  elements.animationHueField.hidden = !definition.hue;
  elements.animationIdField.hidden = !definition.animationId;
  elements.colorShiftField.hidden = !definition.colorShift;

  elements.animationColorInput.value = state.color;
  elements.animationColorSwatch.style.background = color;
  elements.animationColorValue.textContent = color;
  setRangeControl(elements.animationSpeedInput, elements.animationSpeedValue, definition.speed, settings.speed);
  setRangeControl(elements.animationHueInput, elements.animationHueValue, definition.hue, settings.hue);
  setRangeControl(elements.animationIdInput, elements.animationIdValue, definition.animationId, settings.animationId);
  setRangeControl(elements.colorShiftInput, elements.colorShiftValue, definition.colorShift, settings.colorShift);

  elements.animationSummaryName.textContent = definition.name;
  elements.animationSummaryDescription.textContent = customAnimationDescription(definition, settings);
  elements.animationSummarySwatch.dataset.effect = definition.previewEffect;
  elements.animationSummarySwatch.style.setProperty("--summary-color", previewColor);
  elements.animationSummarySwatch.style.background = definition.previewEffect.includes("rainbow")
    ? "conic-gradient(#ff5fa2, #ffc95c, #55ddbd, #6b8cff, #ff5fa2)"
    : previewColor;
  elements.animationPacketPreview.textContent = packetLabel(definition.packet(currentAnimationParameters())).toUpperCase();
}

function factoryIndexHex(index) {
  return index.toString(16).padStart(2, "0").toUpperCase();
}

function factoryEntry(index) {
  return state.factoryPalette[String(index)] || {};
}

function loadFactoryPalette() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FACTORY_PALETTE_STORAGE_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;

    state.factoryPalette = Object.fromEntries(
      Object.entries(saved)
        .filter(([index, entry]) => Number(index) >= 0 && Number(index) <= 27 && entry && typeof entry === "object")
        .map(([index, entry]) => [index, {
          tested: entry.tested === true,
          label: typeof entry.label === "string" ? entry.label.slice(0, 32) : "",
        }]),
    );
  } catch (error) {
    addDiagnostic("WARN", "Saved factory labels could not be loaded", null, "error");
  }
}

function saveFactoryPalette() {
  try {
    window.localStorage.setItem(FACTORY_PALETTE_STORAGE_KEY, JSON.stringify(state.factoryPalette));
    return true;
  } catch (error) {
    addDiagnostic("WARN", "Factory labels could not be saved in this browser", null, "error");
    showToast("This browser could not save the label");
    return false;
  }
}

function renderFactoryPalette() {
  elements.factoryPaletteGrid.replaceChildren();

  for (let index = 0; index < 28; index += 1) {
    const entry = factoryEntry(index);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "factory-color-button";
    button.classList.toggle("active", index === state.selectedFactoryIndex);
    button.classList.toggle("tested", entry.tested === true);
    button.dataset.factoryIndex = String(index);
    button.setAttribute("aria-pressed", String(index === state.selectedFactoryIndex));
    button.setAttribute("aria-label", `Factory color ${factoryIndexHex(index)}${entry.label ? `, ${entry.label}` : ""}`);

    const code = document.createElement("code");
    code.textContent = factoryIndexHex(index);
    const label = document.createElement("small");
    label.textContent = entry.label || (entry.tested ? "Tested" : "Untested");
    button.append(code, label);
    elements.factoryPaletteGrid.append(button);
  }

  const testedCount = Object.values(state.factoryPalette).filter((entry) => entry.tested).length;
  elements.factoryPaletteProgress.textContent = `${testedCount} / 28 tested`;
}

function updateFactorySelection() {
  const index = state.selectedFactoryIndex;
  const entry = factoryEntry(index);
  const hex = factoryIndexHex(index);
  elements.factorySelectionName.textContent = entry.label ? `Index ${hex} · ${entry.label}` : `Index ${hex}`;
  elements.factoryPacketPreview.textContent = packetLabel(activeAdapter().commands.factoryColor(index)).toUpperCase();
  elements.factoryColorLabel.value = entry.label || "";
  elements.testFactoryColorButton.textContent = `Test index ${hex}`;
}

function selectFactoryIndex(index) {
  state.selectedFactoryIndex = index;
  renderFactoryPalette();
  updateFactorySelection();
}

async function sendPacket(packet, label) {
  if (!state.adapter || !state.characteristic) {
    showToast("Connect your Candybong first");
    return false;
  }

  if (state.sending) return false;
  state.sending = true;
  setControlsDisabled(true);
  setCommandStatus("sending", `Sending ${label.toLowerCase()}…`);
  addDiagnostic("TX", label, packet, "tx");

  try {
    const canWriteWithResponse = state.characteristic.properties?.write;
    const canWriteWithoutResponse = state.characteristic.properties?.writeWithoutResponse;

    if (canWriteWithResponse && typeof state.characteristic.writeValueWithResponse === "function") {
      await state.characteristic.writeValueWithResponse(packet);
    } else if (canWriteWithoutResponse && typeof state.characteristic.writeValueWithoutResponse === "function") {
      await state.characteristic.writeValueWithoutResponse(packet);
    } else if (typeof state.characteristic.writeValueWithResponse === "function") {
      await state.characteristic.writeValueWithResponse(packet);
    } else {
      await state.characteristic.writeValue(packet);
    }

    setCommandStatus("success", `${label} sent · ${packetLabel(packet)}`);
    showToast(`${label} applied`);
    return true;
  } catch (error) {
    console.error(error);
    addDiagnostic("ERR", `${label} failed: ${error.message || "Bluetooth write error"}`, null, "error");
    setCommandStatus("error", `${label} failed. Try again.`);
    showToast("The command could not be sent");
    return false;
  } finally {
    state.sending = false;
    setControlsDisabled(!isConnected());
  }
}

function handleResponseValue(event) {
  const value = event.target?.value;
  if (!value) return;
  const packet = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  addDiagnostic("RX", "Device response", packet, "rx");
}

function clearResponseCharacteristic() {
  if (state.responseCharacteristic) {
    state.responseCharacteristic.removeEventListener("characteristicvaluechanged", handleResponseValue);
  }
  state.responseCharacteristic = null;
}

async function setupResponseNotifications(service) {
  clearResponseCharacteristic();

  try {
    const responseCharacteristic = await service.getCharacteristic(state.adapter.responseUuid);
    const supportsNotifications = responseCharacteristic.properties?.notify || responseCharacteristic.properties?.indicate;
    if (!supportsNotifications || typeof responseCharacteristic.startNotifications !== "function") {
      throw new Error("Response characteristic does not support notifications");
    }

    state.responseCharacteristic = responseCharacteristic;
    responseCharacteristic.addEventListener("characteristicvaluechanged", handleResponseValue);
    await responseCharacteristic.startNotifications();
    setResponseStatus("RX listening", "listening");
    addDiagnostic("SYS", "Response notifications enabled", null, "status");
  } catch (error) {
    clearResponseCharacteristic();
    setResponseStatus("RX unavailable", "warning");
    addDiagnostic("WARN", error.message || "Response notifications unavailable", null, "error");
  }
}

async function connect() {
  if (!window.isSecureContext) {
    setConnectionStatus(false, "Bluetooth needs HTTPS or localhost.");
    showToast("Open this page through HTTPS or localhost");
    return;
  }

  if (!("bluetooth" in navigator)) {
    setConnectionStatus(false, "This browser does not support Web Bluetooth.");
    showToast("Web Bluetooth is unavailable in this browser");
    return;
  }

  elements.connectButton.disabled = true;
  elements.connectButton.textContent = "Connecting…";
  elements.connectionTitle.textContent = "Choose your Candybong";
  elements.connectionMessage.textContent = "Select TWICE LightStick in the Bluetooth picker.";

  try {
    state.device = await navigator.bluetooth.requestDevice(bluetoothRequestOptions());
    state.adapter = adapterForDevice(state.device);
    if (!state.adapter) throw new Error("No supported lightstick profile");

    state.device.addEventListener("gattserverdisconnected", handleDisconnect);
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(state.adapter.serviceUuid);
    state.characteristic = await service.getCharacteristic(state.adapter.commandUuid);
    await setupResponseNotifications(service);
    setConnectionStatus(true);
    setCommandStatus(null, "Connected · no command sent yet");
    addDiagnostic("SYS", `Connected to ${state.device.name || state.adapter.label}`, null, "status");
    showToast("Candybong connected");
  } catch (error) {
    console.error(error);
    state.device = null;
    state.adapter = null;
    state.characteristic = null;
    clearResponseCharacteristic();
    setResponseStatus("Not connected");
    if (error.name === "NotFoundError") {
      setConnectionStatus(false, "No lightstick selected. Tap connect to try again.");
    } else {
      setConnectionStatus(false, "Could not connect. Keep the lightstick awake and try again.");
      showToast("Connection failed");
    }
  } finally {
    elements.connectButton.disabled = false;
  }
}

function handleDisconnect() {
  clearResponseCharacteristic();
  state.adapter = null;
  state.characteristic = null;
  state.sending = false;
  setResponseStatus("Not connected");
  setConnectionStatus(false, "The lightstick disconnected. Tap connect to reconnect.");
  setCommandStatus(null, "Disconnected");
  addDiagnostic("SYS", "Lightstick disconnected", null, "status");
}

function disconnect() {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  } else {
    handleDisconnect();
  }
}

function selectSolidColor(color) {
  state.color = color.toLowerCase();
  state.activeScene = null;
  state.activeCustomAnimation = null;
  state.activeFactoryIndex = null;
  state.poweredOff = false;
  elements.colorInput.value = state.color;
  updatePreview();
}

function updatePreview() {
  const selectedColor = state.color.toUpperCase();
  const scene = state.activeScene ? activeAdapter().scenes[state.activeScene] : null;
  const effect = state.activeCustomAnimation || scene;
  const factoryActive = state.activeFactoryIndex !== null;
  const color = factoryActive ? "#D9CFD5" : (effect?.color || selectedColor).toUpperCase();
  const brightness = state.brightness / 10;

  elements.lightstickVisual.style.setProperty("--light-color", color);
  elements.lightstickVisual.style.setProperty("--light-alpha", String(effect || factoryActive ? 1 : Math.max(0.08, brightness)));
  elements.lightstickVisual.dataset.effect = factoryActive ? "solid" : effect?.previewEffect || "solid";
  elements.lightstickVisual.classList.toggle("is-off", state.poweredOff || (!effect && !factoryActive && state.brightness === 0));
  elements.colorSwatch.style.background = selectedColor;
  elements.hexValue.textContent = factoryActive ? `INDEX ${factoryIndexHex(state.activeFactoryIndex)}` : color;
  elements.brightnessValue.textContent = `${state.brightness} / 10`;
  elements.brightnessInput.style.setProperty("--progress", `${state.brightness * 10}%`);

  if (factoryActive) {
    const entry = factoryEntry(state.activeFactoryIndex);
    elements.previewMode.textContent = "Factory";
    elements.previewName.textContent = entry.label || `Factory color ${factoryIndexHex(state.activeFactoryIndex)}`;
    elements.previewDescription.textContent = "Device-defined palette color";
  } else if (effect) {
    elements.previewMode.textContent = "Effect";
    elements.previewName.textContent = effect.name;
    elements.previewDescription.textContent = effect.description;
  } else if (state.poweredOff) {
    elements.previewMode.textContent = "Off";
    elements.previewName.textContent = "Lightstick off";
    elements.previewDescription.textContent = "Turn it on to continue";
  } else {
    elements.previewMode.textContent = "Solid";
    elements.previewName.textContent = color === "#FF5FA2" ? "Candy pink" : "Custom color";
    elements.previewDescription.textContent = `Solid color · brightness ${state.brightness}`;
  }

  elements.colorPresets.forEach((button) => {
    button.classList.toggle("active", !effect && !factoryActive && button.dataset.color.toUpperCase() === selectedColor);
  });
  elements.sceneButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.scene === state.activeScene);
  });
  updateAnimationBuilder();
}

elements.connectButton.addEventListener("click", () => {
  if (isConnected()) disconnect();
  else connect();
});

elements.onButton.addEventListener("click", async () => {
  if (await sendPacket(state.adapter.commands.powerOn(), "Power on")) {
    state.poweredOff = false;
    updatePreview();
  }
});

elements.offButton.addEventListener("click", async () => {
  if (await sendPacket(state.adapter.commands.powerOff(), "Power off")) {
    state.poweredOff = true;
    state.activeScene = null;
    state.activeCustomAnimation = null;
    state.activeFactoryIndex = null;
    updatePreview();
  }
});

elements.applyColorButton.addEventListener("click", async () => {
  if (await sendPacket(state.adapter.commands.staticColor(state.color, state.brightness), "Solid color")) {
    state.activeScene = null;
    state.activeCustomAnimation = null;
    state.activeFactoryIndex = null;
    state.poweredOff = state.brightness === 0;
    updatePreview();
  }
});

elements.colorInput.addEventListener("input", (event) => selectSolidColor(event.target.value));

elements.colorPresets.forEach((button) => {
  button.addEventListener("click", () => selectSolidColor(button.dataset.color));
});

elements.brightnessInput.addEventListener("input", (event) => {
  state.brightness = Number(event.target.value);
  state.activeScene = null;
  state.activeCustomAnimation = null;
  state.activeFactoryIndex = null;
  state.poweredOff = state.brightness === 0;
  updatePreview();
});

elements.sceneButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const scene = state.adapter?.scenes[button.dataset.scene];
    if (!scene) return;

    if (await sendPacket(scene.packet(), scene.name)) {
      state.activeScene = button.dataset.scene;
      state.activeCustomAnimation = null;
      state.activeFactoryIndex = null;
      state.color = scene.color;
      state.poweredOff = false;
      elements.colorInput.value = scene.color;
      updatePreview();
    }
  });
});

elements.animationMode.addEventListener("change", (event) => {
  state.animationMode = event.target.value;
  updateAnimationBuilder();
});

elements.animationColorInput.addEventListener("input", (event) => selectSolidColor(event.target.value));

elements.animationSpeedInput.addEventListener("input", (event) => {
  currentAnimationSettings().speed = Number(event.target.value);
  updateAnimationBuilder();
});

elements.animationHueInput.addEventListener("input", (event) => {
  currentAnimationSettings().hue = Number(event.target.value);
  updateAnimationBuilder();
});

elements.animationIdInput.addEventListener("input", (event) => {
  currentAnimationSettings().animationId = Number(event.target.value);
  updateAnimationBuilder();
});

elements.colorShiftInput.addEventListener("input", (event) => {
  currentAnimationSettings().colorShift = Number(event.target.value);
  updateAnimationBuilder();
});

elements.applyAnimationButton.addEventListener("click", async () => {
  const definition = currentAnimationDefinition();
  const settings = currentAnimationSettings();
  const packet = definition.packet(currentAnimationParameters());

  if (await sendPacket(packet, definition.name)) {
    state.activeScene = null;
    state.activeFactoryIndex = null;
    state.activeCustomAnimation = {
      name: definition.animationId ? `${definition.name} ${settings.animationId}` : definition.name,
      description: customAnimationDescription(definition, settings),
      previewEffect: definition.previewEffect,
      color: definition.usesColor ? state.color : definition.previewColor,
    };
    state.poweredOff = false;
    updatePreview();
  }
});

elements.factoryPaletteGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-factory-index]");
  if (!button) return;
  selectFactoryIndex(Number(button.dataset.factoryIndex));
});

elements.testFactoryColorButton.addEventListener("click", async () => {
  const index = state.selectedFactoryIndex;
  const label = `Factory color ${factoryIndexHex(index)}`;

  if (await sendPacket(state.adapter.commands.factoryColor(index), label)) {
    const entry = factoryEntry(index);
    state.factoryPalette[String(index)] = { ...entry, tested: true };
    saveFactoryPalette();
    state.activeScene = null;
    state.activeCustomAnimation = null;
    state.activeFactoryIndex = index;
    state.poweredOff = false;
    renderFactoryPalette();
    updateFactorySelection();
    updatePreview();
  }
});

elements.saveFactoryLabelButton.addEventListener("click", () => {
  const label = elements.factoryColorLabel.value.trim();
  if (!label) {
    showToast("Enter the observed color name first");
    elements.factoryColorLabel.focus();
    return;
  }

  const index = state.selectedFactoryIndex;
  state.factoryPalette[String(index)] = { tested: true, label: label.slice(0, 32) };
  if (saveFactoryPalette()) showToast(`Label saved for index ${factoryIndexHex(index)}`);
  renderFactoryPalette();
  updateFactorySelection();
  if (state.activeFactoryIndex === index) updatePreview();
});

elements.clearFactoryResultButton.addEventListener("click", () => {
  const index = state.selectedFactoryIndex;
  if (!factoryEntry(index).tested && !factoryEntry(index).label) {
    showToast("This index has no saved result");
    return;
  }

  delete state.factoryPalette[String(index)];
  if (saveFactoryPalette()) showToast(`Saved result cleared for index ${factoryIndexHex(index)}`);
  renderFactoryPalette();
  updateFactorySelection();
  if (state.activeFactoryIndex === index) updatePreview();
});

elements.factoryColorLabel.addEventListener("keydown", (event) => {
  if (event.key === "Enter") elements.saveFactoryLabelButton.click();
});

elements.clearDiagnosticsButton.addEventListener("click", () => {
  state.diagnostics = [];
  renderDiagnostics();
});

function initializeSupportMessage() {
  if (!window.isSecureContext) {
    elements.supportNote.textContent = "Unavailable here · HTTPS or localhost required";
    elements.connectButton.disabled = true;
  } else if (!("bluetooth" in navigator)) {
    elements.supportNote.textContent = "Web Bluetooth is not supported by this browser";
    elements.connectButton.disabled = true;
  } else {
    elements.supportNote.textContent = "Web Bluetooth ready · Nordic UART profile";
  }
}

loadFactoryPalette();
renderFactoryPalette();
updateFactorySelection();
renderDiagnostics();
updatePreview();
setConnectionStatus(false);
initializeSupportMessage();
