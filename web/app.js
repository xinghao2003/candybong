import { LIGHTSTICK_ADAPTERS, adapterForDevice, bluetoothRequestOptions } from "./adapters.js";

const defaultAdapter = LIGHTSTICK_ADAPTERS[0];
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
  color: "#ff5fa2",
  brightness: 10,
  activeScene: null,
  activeCustomAnimation: null,
  animationMode: "pulse",
  animationSettings,
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

async function sendPacket(packet, label) {
  if (!state.adapter || !state.characteristic) {
    showToast("Connect your Candybong first");
    return false;
  }

  if (state.sending) return false;
  state.sending = true;
  setControlsDisabled(true);
  setCommandStatus("sending", `Sending ${label.toLowerCase()}…`);

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
    setCommandStatus("error", `${label} failed. Try again.`);
    showToast("The command could not be sent");
    return false;
  } finally {
    state.sending = false;
    setControlsDisabled(!isConnected());
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
    setConnectionStatus(true);
    setCommandStatus(null, "Connected · no command sent yet");
    showToast("Candybong connected");
  } catch (error) {
    console.error(error);
    state.device = null;
    state.adapter = null;
    state.characteristic = null;
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
  state.adapter = null;
  state.characteristic = null;
  state.sending = false;
  setConnectionStatus(false, "The lightstick disconnected. Tap connect to reconnect.");
  setCommandStatus(null, "Disconnected");
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
  state.poweredOff = false;
  elements.colorInput.value = state.color;
  updatePreview();
}

function updatePreview() {
  const selectedColor = state.color.toUpperCase();
  const scene = state.activeScene ? activeAdapter().scenes[state.activeScene] : null;
  const effect = state.activeCustomAnimation || scene;
  const color = (effect?.color || selectedColor).toUpperCase();
  const brightness = state.brightness / 10;

  elements.lightstickVisual.style.setProperty("--light-color", color);
  elements.lightstickVisual.style.setProperty("--light-alpha", String(effect ? 1 : Math.max(0.08, brightness)));
  elements.lightstickVisual.dataset.effect = effect?.previewEffect || "solid";
  elements.lightstickVisual.classList.toggle("is-off", state.poweredOff || (!effect && state.brightness === 0));
  elements.colorSwatch.style.background = selectedColor;
  elements.hexValue.textContent = color;
  elements.brightnessValue.textContent = `${state.brightness} / 10`;
  elements.brightnessInput.style.setProperty("--progress", `${state.brightness * 10}%`);

  if (effect) {
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
    button.classList.toggle("active", !effect && button.dataset.color.toUpperCase() === selectedColor);
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
    updatePreview();
  }
});

elements.applyColorButton.addEventListener("click", async () => {
  if (await sendPacket(state.adapter.commands.staticColor(state.color, state.brightness), "Solid color")) {
    state.activeScene = null;
    state.activeCustomAnimation = null;
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

updatePreview();
setConnectionStatus(false);
initializeSupportMessage();
