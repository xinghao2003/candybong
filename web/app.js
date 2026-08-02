import { LIGHTSTICK_ADAPTERS, adapterForDevice, bluetoothRequestOptions } from "./adapters.js";
import { MicrophoneReactiveController, microphoneErrorMessage, microphoneSupportMessage } from "./music-reactive.js";
import { cueModeLabel } from "./show-format.js";
import { TrackStudio } from "./track-studio.js";
import { BlinkLab } from "./blink-lab.js";
import { CaptureGuide } from "./capture-guide.js";
import { AlignmentGuide } from "./align-guide.js";
import { CameraLumaTracker, cameraErrorMessage, cameraSupportMessage } from "./camera-luma.js";

const defaultAdapter = LIGHTSTICK_ADAPTERS[0];
const FACTORY_PALETTE_STORAGE_KEY = "candybong-factory-palette-v1";
const FACTORY_MEMBER_PALETTE = Object.freeze({
  0x00: "Dahyun",
  0x01: "Chaeyoung",
  0x02: "Jihyo",
  0x09: "Jeongyeon",
  0x0b: "Mina",
  0x0e: "Nayeon",
  0x14: "Tzuyu",
  0x16: "Sana",
  0x1b: "Momo",
});
const MAX_DIAGNOSTIC_ENTRIES = 100;
const LATENCY_PROBE_COUNT = 5;
const LATENCY_PROBE_GAP_MS = 250;
const LATENCY_RX_TIMEOUT_MS = 1000;
const LATENCY_FLASH_MIN_DELAY_MS = 700;
const LATENCY_FLASH_MAX_DELAY_MS = 2000;
const LATENCY_TAP_TIMEOUT_MS = 10000;
const LATENCY_CAMERA_TIMEOUT_MS = 4000;
const LATENCY_CAMERA_SETTLE_MS = 400;
const MUSIC_WRITE_INTERVAL_MS = 125;
const MUSIC_DIAGNOSTIC_INTERVAL_MS = 1000;
const MUSIC_MODE_LABELS = {
  pulse: "Volume pulse",
  beat: "Bass beat flash",
  spectrum: "Spectrum color",
};
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
  timelineCue: null,
  factoryPalette: {},
  diagnostics: [],
  latency: {
    running: false,
    tapActive: false,
    pendingRtt: null,
    taps: [],
    flashStartedAt: null,
    tapTimeout: null,
    restoreColor: "#ff5fa2",
    restoreBrightness: 10,
    wasPoweredOff: false,
    cameraTracker: null,
    guide: null,
    cameraOn: false,
    cameraTestActive: false,
    pendingRise: null,
    pendingRiseTimer: null,
    pendingRestore: null,
    pendingRestoreTimer: null,
    flashWriteAt: null,
    restoreWriteAt: null,
    flashOnMs: null,
    flashOffMs: null,
  },
  poweredOff: false,
  sending: false,
  music: {
    active: false,
    starting: false,
    mode: "pulse",
    sensitivity: 5,
    maximumBrightness: 10,
    color: "#ff5fa2",
    brightness: 1,
    level: 0,
    bass: 0,
    errorMessage: "",
    stopMessage: "",
    lastPacketKey: "",
    lastWriteAt: 0,
    lastDiagnosticAt: 0,
    writePromise: null,
  },
};

let trackStudio = null;
let blinkLab = null;
let captureLab = null;
let timelineWriteChain = Promise.resolve();

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
  latencyStatus: document.querySelector("#latencyStatus"),
  latencyRunProbesButton: document.querySelector("#latencyRunProbesButton"),
  latencyProbeList: document.querySelector("#latencyProbeList"),
  latencyProbeSummary: document.querySelector("#latencyProbeSummary"),
  latencyTapButton: document.querySelector("#latencyTapButton"),
  latencyTapResult: document.querySelector("#latencyTapResult"),
  latencyCameraButton: document.querySelector("#latencyCameraButton"),
  latencyFlashButton: document.querySelector("#latencyFlashButton"),
  latencyFlashFrame: document.querySelector("#latencyFlashFrame"),
  latencyFlashVideo: document.querySelector("#latencyFlashVideo"),
  latencyGuideReset: document.querySelector("#latencyGuideReset"),
  latencyFlashResult: document.querySelector("#latencyFlashResult"),
  diagnosticLog: document.querySelector("#diagnosticLog"),
  diagnosticEmpty: document.querySelector("#diagnosticEmpty"),
  clearDiagnosticsButton: document.querySelector("#clearDiagnosticsButton"),
  sceneButtons: [...document.querySelectorAll("[data-scene]")],
  musicMode: document.querySelector("#musicMode"),
  musicSensitivityInput: document.querySelector("#musicSensitivityInput"),
  musicSensitivityValue: document.querySelector("#musicSensitivityValue"),
  musicBrightnessInput: document.querySelector("#musicBrightnessInput"),
  musicBrightnessValue: document.querySelector("#musicBrightnessValue"),
  startMusicButton: document.querySelector("#startMusicButton"),
  stopMusicButton: document.querySelector("#stopMusicButton"),
  musicNote: document.querySelector("#musicNote"),
  musicStatus: document.querySelector("#musicStatus"),
  musicStatusDetail: document.querySelector("#musicStatusDetail"),
  musicStatusDot: document.querySelector("#musicStatusDot"),
  musicLevelMeter: document.querySelector("#musicLevelMeter"),
  musicLevelFill: document.querySelector("#musicLevelFill"),
  musicLevelValue: document.querySelector("#musicLevelValue"),
  musicBassMeter: document.querySelector("#musicBassMeter"),
  musicBassFill: document.querySelector("#musicBassFill"),
  musicBassValue: document.querySelector("#musicBassValue"),
  musicBeatIndicator: document.querySelector("#musicBeatIndicator"),
  toast: document.querySelector("#toast"),
};

const microphoneController = new MicrophoneReactiveController({
  getSettings: () => ({
    color: state.color,
    maximumBrightness: state.music.maximumBrightness,
    mode: state.music.mode,
    sensitivity: state.music.sensitivity,
  }),
  onFrame: handleMusicFrame,
  onEnded: handleMicrophoneEnded,
});

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
  updateMusicControls(disabled);
  updateLatencyControls();
  blinkLab?.setConnected(!disabled);
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

function setMusicMeter(meter, fill, output, value) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  meter.setAttribute("aria-valuenow", String(percent));
  fill.style.width = `${percent}%`;
  output.textContent = `${percent}%`;
}

function updateMusicRanges() {
  const sensitivityProgress = ((state.music.sensitivity - 1) / 9) * 100;
  const brightnessProgress = ((state.music.maximumBrightness - 1) / 9) * 100;
  elements.musicSensitivityInput.style.setProperty("--progress", `${sensitivityProgress}%`);
  elements.musicBrightnessInput.style.setProperty("--progress", `${brightnessProgress}%`);
  elements.musicSensitivityValue.textContent = `${state.music.sensitivity} / 10`;
  elements.musicBrightnessValue.textContent = `${state.music.maximumBrightness} / 10`;
}

function updateMusicControls(controlsDisabled = !isConnected() || state.sending) {
  const supportError = microphoneSupportMessage();
  const music = state.music;

  elements.startMusicButton.disabled = controlsDisabled || music.active || music.starting || Boolean(supportError);
  elements.stopMusicButton.disabled = !music.active && !music.starting;
  elements.musicMode.disabled = music.starting;
  elements.musicSensitivityInput.disabled = music.starting;
  elements.musicBrightnessInput.disabled = music.starting;
  elements.musicStatusDot.classList.remove("starting", "listening", "error");

  if (music.starting) {
    elements.musicStatus.textContent = "Requesting microphone";
    elements.musicStatusDetail.textContent = "Use the browser prompt to allow access";
    elements.musicStatusDot.classList.add("starting");
  } else if (music.active) {
    elements.musicStatus.textContent = "Listening locally";
    elements.musicStatusDetail.textContent = `${MUSIC_MODE_LABELS[music.mode]} · up to 8 updates/sec`;
    elements.musicStatusDot.classList.add("listening");
  } else if (!isConnected()) {
    elements.musicStatus.textContent = "Connect your Candybong";
    elements.musicStatusDetail.textContent = "Microphone is idle";
  } else if (music.errorMessage) {
    elements.musicStatus.textContent = "Microphone unavailable";
    elements.musicStatusDetail.textContent = music.errorMessage;
    elements.musicStatusDot.classList.add("error");
  } else if (supportError) {
    elements.musicStatus.textContent = "Microphone unavailable";
    elements.musicStatusDetail.textContent = supportError;
    elements.musicStatusDot.classList.add("error");
  } else {
    elements.musicStatus.textContent = "Ready to listen";
    elements.musicStatusDetail.textContent = music.stopMessage || "Microphone is idle";
  }

  elements.musicNote.textContent = music.mode === "spectrum"
    ? "Spectrum color maps bass, mids, and treble to RGB. Keep this page in the foreground while listening."
    : "Volume pulse and bass beat use your selected solid color. Keep this page in the foreground while listening.";
  updateMusicRanges();
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

function setLatencyStatus(message, style = null) {
  elements.latencyStatus.textContent = message;
  elements.latencyStatus.classList.remove("listening", "warning");
  if (style) elements.latencyStatus.classList.add(style);
}

function updateLatencyControls() {
  const baseLocked = !isConnected() || state.sending || state.latency.running;
  const cameraLocked = state.latency.tapActive || state.latency.cameraTestActive;
  elements.latencyRunProbesButton.disabled = baseLocked || cameraLocked;
  elements.latencyTapButton.disabled = baseLocked || cameraLocked || (state.latency.tapActive && state.latency.flashStartedAt == null);
  elements.latencyCameraButton.disabled = baseLocked || cameraLocked;
  elements.latencyCameraButton.textContent = state.latency.cameraOn ? "Stop camera" : "Start camera";
  elements.latencyGuideReset.disabled = !state.latency.cameraOn;
  elements.latencyFlashButton.disabled = baseLocked || cameraLocked || !state.latency.cameraOn;
  elements.latencyFlashButton.textContent = state.latency.cameraTestActive ? "Testing…" : "Run flash test";
  if (!state.latency.running && !state.latency.tapActive && !state.latency.cameraTestActive) {
    setLatencyStatus(isConnected() ? "Ready" : "Not connected", null);
  }
}

function cancelLatencyTests() {
  if (state.latency.pendingRtt) {
    const entry = state.latency.pendingRtt;
    state.latency.pendingRtt = null;
    window.clearTimeout(entry.timer);
    entry.resolve(null);
  }
  window.clearTimeout(state.latency.tapTimeout);
  state.latency.tapTimeout = null;
  state.latency.flashStartedAt = null;
  state.latency.running = false;
  state.latency.tapActive = false;
  elements.latencyTapButton.classList.remove("armed");
  elements.latencyTapButton.textContent = "Start test";
  cancelCameraFlashTest();
  updateLatencyControls();
}

async function latencyPreamble() {
  trackStudio?.pauseForManualControl();
  state.timelineCue = null;
  if (state.music.writePromise) {
    try { await state.music.writePromise; } catch (error) { /* The reactive writer reports its own error. */ }
  }
  try { await timelineWriteChain; } catch (error) { /* Timeline write errors are reported where they occur. */ }
  if (state.music.active || state.music.starting) stopMusicReactive("Stopped by latency test");
}

// Resolves when the next response notification arrives, or after the timeout.
function armRtt() {
  if (!state.responseCharacteristic) return null;
  const entry = {};
  entry.promise = new Promise((resolve) => {
    entry.resolve = resolve;
  });
  entry.timer = window.setTimeout(() => {
    if (state.latency.pendingRtt === entry) state.latency.pendingRtt = null;
    entry.resolve(null);
  }, LATENCY_RX_TIMEOUT_MS);
  state.latency.pendingRtt = entry;
  return entry;
}

async function probeOnce(packet, label) {
  addDiagnostic("TX", label, packet, "tx");
  const rtt = armRtt();
  const writeStart = performance.now();
  let writeMs = null;
  try {
    await writeCharacteristic(packet, false);
    writeMs = performance.now() - writeStart;
  } catch (error) {
    console.error(error);
    addDiagnostic("ERR", `${label} failed: ${error.message || "Bluetooth write error"}`, null, "error");
    if (rtt) {
      if (state.latency.pendingRtt === rtt) state.latency.pendingRtt = null;
      window.clearTimeout(rtt.timer);
      rtt.resolve(null);
    }
    return { label, writeMs, echoMs: null, echoState: "failed" };
  }
  const rxAt = await rtt?.promise;
  return {
    label,
    writeMs,
    echoMs: rxAt == null ? null : Math.max(0, rxAt - writeStart),
    echoState: rxAt == null ? (rtt ? "timeout" : "unavailable") : "ok",
  };
}

function renderLatencyProbeList(results) {
  elements.latencyProbeList.replaceChildren();
  for (const probe of results) {
    const item = document.createElement("li");
    const write = probe.writeMs == null ? "—" : `${probe.writeMs.toFixed(0)} ms`;
    const echo = probe.echoMs != null
      ? `${probe.echoMs.toFixed(0)} ms`
      : probe.echoState === "timeout" ? "no echo" : probe.echoState === "failed" ? "failed" : "n/a";
    item.textContent = `${probe.label}: write ${write} · echo ${echo}`;
    elements.latencyProbeList.append(item);
  }
}

function statsLabel(times) {
  if (!times.length) return "no samples";
  const min = Math.round(Math.min(...times));
  const max = Math.round(Math.max(...times));
  const avg = Math.round(times.reduce((sum, time) => sum + time, 0) / times.length);
  return `${min}–${max} ms · avg ${avg} ms`;
}

function renderLatencyProbeSummary(results) {
  const writeTimes = results.filter((probe) => probe.writeMs != null).map((probe) => probe.writeMs);
  const echoTimes = results.filter((probe) => probe.echoMs != null).map((probe) => probe.echoMs);
  const writeStats = statsLabel(writeTimes);
  const echoStats = statsLabel(echoTimes);
  elements.latencyProbeSummary.textContent = `Write ${writeStats} · RX echo ${echoStats}`;
  if (writeTimes.length || echoTimes.length) {
    addDiagnostic("SYS", `Latency probes: write ${writeStats} · RX echo ${echoStats}`, null, "status");
  }
}

async function runLatencyProbes() {
  if (!isConnected() || state.latency.running || state.latency.tapActive) return;
  await latencyPreamble();
  if (!isConnected()) return;
  state.latency.running = true;
  updateLatencyControls();
  setLatencyStatus("Probing…", "listening");
  renderLatencyProbeList([]);
  elements.latencyProbeSummary.textContent = "Probing…";

  const wasPoweredOff = state.poweredOff;
  const color = state.color;
  const brightness = Math.max(1, state.brightness);
  const packets = Array.from({ length: LATENCY_PROBE_COUNT }, (_, index) =>
    state.adapter.commands.staticColor(index % 2 === 0 ? color : "#ffffff", index % 2 === 0 ? brightness : 10));
  const results = [];
  for (let index = 0; index < packets.length; index += 1) {
    if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, LATENCY_PROBE_GAP_MS));
    results.push(await probeOnce(packets[index], `Latency probe ${index + 1}`));
    renderLatencyProbeList(results);
  }
  renderLatencyProbeSummary(results);

  if (wasPoweredOff && isConnected()) {
    const packet = state.adapter.commands.powerOff();
    addDiagnostic("TX", "Latency restore · power off", packet, "tx");
    writeCharacteristic(packet, false).catch((error) => console.error(error));
  }

  state.latency.running = false;
  updateLatencyControls();
  setLatencyStatus(isConnected() ? "Ready" : "Not connected", null);
}

function restoreLatencyFlash() {
  if (!isConnected()) return;
  const packet = state.latency.wasPoweredOff
    ? state.adapter.commands.powerOff()
    : state.adapter.commands.staticColor(state.latency.restoreColor, state.latency.restoreBrightness);
  addDiagnostic("TX", state.latency.wasPoweredOff ? "Latency restore · power off" : "Latency restore · color", packet, "tx");
  writeCharacteristic(packet, false).catch((error) => console.error(error));
}

async function startLatencyTapTest() {
  if (!isConnected() || state.latency.running || state.latency.tapActive) return;
  state.latency.tapActive = true;
  state.latency.wasPoweredOff = state.poweredOff;
  state.latency.restoreColor = state.color;
  state.latency.restoreBrightness = state.brightness;
  updateLatencyControls();
  await latencyPreamble();
  if (!isConnected()) {
    cancelLatencyTests();
    return;
  }
  setLatencyStatus("Waiting for tap…", "listening");

  const tap = elements.latencyTapButton;
  tap.textContent = "Get ready…";
  const delay = LATENCY_FLASH_MIN_DELAY_MS + Math.random() * (LATENCY_FLASH_MAX_DELAY_MS - LATENCY_FLASH_MIN_DELAY_MS);
  await new Promise((resolve) => window.setTimeout(resolve, delay));
  if (!isConnected()) {
    cancelLatencyTests();
    return;
  }

  state.latency.flashStartedAt = performance.now();
  const flashPacket = state.adapter.commands.staticColor("#ffffff", 10);
  addDiagnostic("TX", "Latency flash · white", flashPacket, "tx");
  writeCharacteristic(flashPacket, false).catch((error) => {
    console.error(error);
    setLatencyStatus("Flash failed", "warning");
    cancelLatencyTests();
  });

  tap.textContent = "TAP NOW!";
  tap.classList.add("armed");
  updateLatencyControls();
  state.latency.tapTimeout = window.setTimeout(() => {
    if (state.latency.flashStartedAt == null) return;
    state.latency.flashStartedAt = null;
    state.latency.tapActive = false;
    restoreLatencyFlash();
    elements.latencyTapResult.textContent = "Flash missed — try again";
    tap.classList.remove("armed");
    tap.textContent = "Start test";
    updateLatencyControls();
  }, LATENCY_TAP_TIMEOUT_MS);
}

function renderLatencyTapResult() {
  const taps = state.latency.taps;
  if (!taps.length) {
    elements.latencyTapResult.textContent = "Not tested yet";
    return;
  }
  const last = Math.round(taps[taps.length - 1]);
  const best = Math.round(Math.min(...taps));
  const avg = Math.round(taps.reduce((sum, time) => sum + time, 0) / taps.length);
  elements.latencyTapResult.textContent = `Last ${last} ms · best ${best} ms · avg ${avg} ms (${taps.length} ${taps.length === 1 ? "tap" : "taps"})`;
}

// Camera flash test: the camera watches the lightstick while it flashes white,
// timing the write until the visible change. The settle write before the flash
// puts the light on a steady color so the flash is the only edge the camera sees.
function cameraFlashSample(sample) {
  if (!state.latency.cameraTestActive) return;
  if (state.latency.pendingRise && sample.edge === "rise") {
    state.latency.pendingRise = null;
    window.clearTimeout(state.latency.pendingRiseTimer);
    state.latency.flashOnMs = Math.max(0, sample.edgeAt - state.latency.flashWriteAt);
    sendLatencyFlashRestore();
  } else if (state.latency.pendingRestore && sample.edge === "fall") {
    state.latency.pendingRestore = null;
    window.clearTimeout(state.latency.pendingRestoreTimer);
    state.latency.flashOffMs = Math.max(0, sample.edgeAt - state.latency.restoreWriteAt);
    finishCameraFlashTest();
  }
}

function sendLatencyFlashRestore() {
  if (!isConnected()) {
    finishCameraFlashTest();
    return;
  }
  const packet = state.latency.wasPoweredOff
    ? state.adapter.commands.powerOff()
    : state.adapter.commands.staticColor(state.latency.restoreColor, state.latency.restoreBrightness);
  state.latency.restoreWriteAt = performance.now();
  addDiagnostic("TX", state.latency.wasPoweredOff ? "Latency flash restore · power off" : "Latency flash restore · color", packet, "tx");
  writeCharacteristic(packet, false).catch((error) => console.error(error));
  state.latency.pendingRestore = true;
  state.latency.pendingRestoreTimer = window.setTimeout(() => {
    state.latency.pendingRestore = null;
    finishCameraFlashTest();
  }, LATENCY_CAMERA_TIMEOUT_MS);
}

async function runCameraFlashTest() {
  if (!isConnected() || state.latency.running || state.latency.tapActive || state.latency.cameraTestActive || !state.latency.cameraOn) return;
  if (state.color.toLowerCase() === "#ffffff" && state.brightness >= 9) {
    showToast("The light is already near-white — the flash won't be visible");
    return;
  }
  state.latency.cameraTestActive = true;
  state.latency.wasPoweredOff = state.poweredOff;
  state.latency.restoreColor = state.color;
  state.latency.restoreBrightness = state.brightness;
  state.latency.flashOnMs = null;
  state.latency.flashOffMs = null;
  state.latency.pendingRise = null;
  state.latency.pendingRestore = null;
  updateLatencyControls();
  elements.latencyFlashResult.textContent = "Settling…";
  await latencyPreamble();
  if (!isConnected()) {
    cancelCameraFlashTest();
    return;
  }

  if (!state.latency.wasPoweredOff) {
    const settlePacket = state.adapter.commands.staticColor(state.latency.restoreColor, state.latency.restoreBrightness);
    addDiagnostic("TX", "Latency flash settle · steady color", settlePacket, "tx");
    writeCharacteristic(settlePacket, false).catch((error) => console.error(error));
  }
  await new Promise((resolve) => window.setTimeout(resolve, LATENCY_CAMERA_SETTLE_MS));
  if (!isConnected()) {
    cancelCameraFlashTest();
    return;
  }

  state.latency.flashWriteAt = performance.now();
  const flashPacket = state.adapter.commands.staticColor("#ffffff", 10);
  addDiagnostic("TX", "Latency flash · white (camera)", flashPacket, "tx");
  writeCharacteristic(flashPacket, false).catch((error) => {
    console.error(error);
    cancelCameraFlashTest();
  });
  state.latency.pendingRise = true;
  state.latency.pendingRiseTimer = window.setTimeout(() => {
    if (state.latency.pendingRise) {
      state.latency.pendingRise = null;
      finishCameraFlashTest();
    }
  }, LATENCY_CAMERA_TIMEOUT_MS);
  elements.latencyFlashResult.textContent = "Waiting for the flash…";
  setLatencyStatus("Camera flash test…", "listening");
}

function finishCameraFlashTest() {
  state.latency.cameraTestActive = false;
  window.clearTimeout(state.latency.pendingRiseTimer);
  window.clearTimeout(state.latency.pendingRestoreTimer);
  const parts = [];
  if (state.latency.flashOnMs != null) parts.push(`flash on ${Math.round(state.latency.flashOnMs)} ms`);
  else parts.push("flash not seen");
  if (state.latency.flashOffMs != null) parts.push(`restore ${Math.round(state.latency.flashOffMs)} ms`);
  elements.latencyFlashResult.textContent = `Last test: ${parts.join(" · ")}`;
  addDiagnostic("SYS", `Camera latency: ${parts.join(", ")}`, null, "status");
  state.latency.pendingRise = null;
  state.latency.pendingRestore = null;
  state.latency.flashWriteAt = null;
  state.latency.restoreWriteAt = null;
  updateLatencyControls();
  setLatencyStatus(isConnected() ? "Ready" : "Not connected", null);
}

function cancelCameraFlashTest() {
  const wasActive = state.latency.cameraTestActive;
  const restoreNeeded = wasActive && state.latency.flashWriteAt != null && !state.latency.pendingRestore;
  state.latency.cameraTestActive = false;
  window.clearTimeout(state.latency.pendingRiseTimer);
  window.clearTimeout(state.latency.pendingRestoreTimer);
  state.latency.pendingRise = null;
  state.latency.pendingRestore = null;
  state.latency.flashWriteAt = null;
  state.latency.restoreWriteAt = null;
  if (restoreNeeded) restoreLatencyFlash();
  elements.latencyFlashResult.textContent = "Test cancelled";
  updateLatencyControls();
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

function storedFactoryEntry(index) {
  return state.factoryPalette[String(index)] || {};
}

function factoryEntry(index) {
  const storedEntry = storedFactoryEntry(index);
  const provisionalLabel = FACTORY_MEMBER_PALETTE[index] || "";
  return {
    tested: storedEntry.tested === true,
    label: storedEntry.label || provisionalLabel,
    provisional: !storedEntry.label && Boolean(provisionalLabel),
  };
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
    button.setAttribute(
      "aria-label",
      `Factory color ${factoryIndexHex(index)}${entry.label ? `, ${entry.label}${entry.provisional ? ", provisional mapping" : ""}` : ""}`,
    );

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
  elements.factorySelectionName.textContent = entry.label
    ? `Index ${hex} · ${entry.label}${entry.provisional ? " (provisional)" : ""}`
    : `Index ${hex}`;
  elements.factoryPacketPreview.textContent = packetLabel(activeAdapter().commands.factoryColor(index)).toUpperCase();
  elements.factoryColorLabel.value = entry.label || "";
  elements.testFactoryColorButton.textContent = `Test index ${hex}`;
}

function selectFactoryIndex(index) {
  state.selectedFactoryIndex = index;
  renderFactoryPalette();
  updateFactorySelection();
}

async function writeCharacteristic(packet, preferWithoutResponse = false) {
  const characteristic = state.characteristic;
  if (!characteristic || !isConnected()) throw new Error("The Candybong is not connected");

  const canWriteWithResponse = characteristic.properties?.write;
  const canWriteWithoutResponse = characteristic.properties?.writeWithoutResponse;
  if (preferWithoutResponse && canWriteWithoutResponse && typeof characteristic.writeValueWithoutResponse === "function") {
    await characteristic.writeValueWithoutResponse(packet);
  } else if (canWriteWithResponse && typeof characteristic.writeValueWithResponse === "function") {
    await characteristic.writeValueWithResponse(packet);
  } else if (canWriteWithoutResponse && typeof characteristic.writeValueWithoutResponse === "function") {
    await characteristic.writeValueWithoutResponse(packet);
  } else if (typeof characteristic.writeValueWithResponse === "function") {
    await characteristic.writeValueWithResponse(packet);
  } else {
    await characteristic.writeValue(packet);
  }
}

function resetMusicMeters() {
  setMusicMeter(elements.musicLevelMeter, elements.musicLevelFill, elements.musicLevelValue, 0);
  setMusicMeter(elements.musicBassMeter, elements.musicBassFill, elements.musicBassValue, 0);
  elements.musicBeatIndicator.classList.remove("detected");
  elements.musicBeatIndicator.querySelector("small").textContent = "Waiting for audio";
}

function stopMusicReactive(message = "Music mode stopped", { error = false } = {}) {
  const wasRunning = state.music.active || state.music.starting || microphoneController.active;
  microphoneController.stop();
  state.music.active = false;
  state.music.starting = false;
  state.music.level = 0;
  state.music.bass = 0;
  state.music.lastPacketKey = "";
  state.music.lastWriteAt = 0;
  if (wasRunning || error) {
    state.music.errorMessage = error ? message : "";
    state.music.stopMessage = error ? "" : message;
  }
  resetMusicMeters();
  updateMusicControls();
  updatePreview();
  if (wasRunning) addDiagnostic(error ? "ERR" : "SYS", message, null, error ? "error" : "status");
}

function handleMicrophoneEnded() {
  const message = "Microphone input ended. Start listening again to resume.";
  stopMusicReactive(message, { error: true });
  setCommandStatus("error", "Music reactive mode stopped because microphone input ended.");
  showToast("Microphone input ended");
}

async function writeMusicFrame(frame) {
  if (!state.music.active || !state.adapter || !isConnected() || state.sending || state.music.writePromise) return;
  if (frame.timestamp - state.music.lastWriteAt < MUSIC_WRITE_INTERVAL_MS) return;

  const packet = state.adapter.commands.staticColor(frame.color, frame.brightness);
  const packetKey = packetLabel(packet);
  if (packetKey === state.music.lastPacketKey) return;

  state.music.lastWriteAt = frame.timestamp;
  const writePromise = writeCharacteristic(packet, true);
  state.music.writePromise = writePromise;

  try {
    await writePromise;
    if (!state.music.active) return;
    state.music.lastPacketKey = packetKey;
    state.music.color = frame.color;
    state.music.brightness = frame.brightness;
    state.poweredOff = false;
    setCommandStatus("success", `Music reactive · ${MUSIC_MODE_LABELS[state.music.mode]} · brightness ${frame.brightness}`);
    updatePreview();

    if (frame.timestamp - state.music.lastDiagnosticAt >= MUSIC_DIAGNOSTIC_INTERVAL_MS) {
      state.music.lastDiagnosticAt = frame.timestamp;
      addDiagnostic("TX", "Music frame (sampled)", packet, "tx");
    }
  } catch (error) {
    if (state.music.active) {
      const message = error.message || "Bluetooth write error";
      setCommandStatus("error", "Music reactive Bluetooth write failed.");
      stopMusicReactive(`Music reactive write failed: ${message}`, { error: true });
      showToast("Music mode stopped after a Bluetooth error");
    }
  } finally {
    if (state.music.writePromise === writePromise) state.music.writePromise = null;
  }
}

function handleMusicFrame(frame) {
  if (!state.music.active) return;
  state.music.level = frame.level;
  state.music.bass = frame.bass;
  setMusicMeter(elements.musicLevelMeter, elements.musicLevelFill, elements.musicLevelValue, frame.level);
  setMusicMeter(elements.musicBassMeter, elements.musicBassFill, elements.musicBassValue, frame.bass);
  elements.musicBeatIndicator.classList.toggle("detected", frame.beatStrength > 0.35);
  elements.musicBeatIndicator.querySelector("small").textContent = frame.beatStrength > 0.35 ? "Beat detected" : "Listening for bass peaks";
  void writeMusicFrame(frame);
}

async function startMusicReactive() {
  if (!isConnected()) {
    showToast("Connect your Candybong first");
    return;
  }
  const supportError = microphoneSupportMessage();
  if (supportError) {
    state.music.errorMessage = supportError;
    updateMusicControls();
    showToast(supportError);
    return;
  }

  state.music.errorMessage = "";
  state.music.stopMessage = "";
  state.music.starting = true;
  state.music.lastPacketKey = "";
  state.music.lastWriteAt = 0;
  state.music.lastDiagnosticAt = 0;
  updateMusicControls();
  setCommandStatus("sending", "Waiting for microphone permission…");

  try {
    await microphoneController.start();
    if (!isConnected()) {
      stopMusicReactive("Candybong disconnected while the microphone was starting");
      return;
    }

    state.music.starting = false;
    state.music.active = true;
    state.music.color = state.color;
    state.music.brightness = 1;
    state.activeScene = null;
    state.activeCustomAnimation = null;
    state.activeFactoryIndex = null;
    state.poweredOff = false;
    updateMusicControls();
    updatePreview();
    setCommandStatus("success", `Music reactive mode ready · ${MUSIC_MODE_LABELS[state.music.mode]}`);
    addDiagnostic("SYS", "Music reactive microphone started", null, "status");
    showToast("Music reactive mode started");
  } catch (error) {
    microphoneController.stop();
    state.music.starting = false;
    state.music.active = false;
    if (!isConnected() && error.name === "AbortError") {
      state.music.errorMessage = "";
      updateMusicControls();
      return;
    }
    const message = microphoneErrorMessage(error);
    state.music.errorMessage = message;
    updateMusicControls();
    setCommandStatus("error", message);
    addDiagnostic("ERR", `Microphone start failed: ${message}`, null, "error");
    showToast(message);
  }
}

async function stopMusicAndRestore() {
  const wasRunning = state.music.active || state.music.starting;
  stopMusicReactive("Stopped by user");
  if (!wasRunning || !isConnected()) return;

  if (await sendPacket(state.adapter.commands.staticColor(state.color, state.brightness), "Restored solid color")) {
    state.poweredOff = state.brightness === 0;
    updatePreview();
  }
}

async function sendPacket(packet, label) {
  trackStudio?.pauseForManualControl();
  state.timelineCue = null;
  if (state.music.active || state.music.starting) stopMusicReactive("Stopped by manual control");
  if (state.music.writePromise) {
    try { await state.music.writePromise; } catch (error) { /* The reactive writer reports its own error. */ }
  }
  try { await timelineWriteChain; } catch (error) { /* Timeline write errors are reported where they occur. */ }

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
    await writeCharacteristic(packet);

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
  // Resolve the pending latency probe: TX timestamp is stored at write time.
  const entry = state.latency.pendingRtt;
  if (entry) {
    state.latency.pendingRtt = null;
    window.clearTimeout(entry.timer);
    entry.resolve(performance.now());
  }
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
  stopMusicReactive("Lightstick disconnected");
  clearResponseCharacteristic();
  cancelLatencyTests();
  blinkLab?.onDisconnected();
  state.adapter = null;
  state.characteristic = null;
  state.sending = false;
  setResponseStatus("Not connected");
  setConnectionStatus(false, "The lightstick disconnected. Tap connect to reconnect.");
  setCommandStatus(null, "Disconnected");
  addDiagnostic("SYS", "Lightstick disconnected", null, "status");
}

function disconnect() {
  stopMusicReactive("Bluetooth disconnected by user");
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  } else {
    handleDisconnect();
  }
}

function selectSolidColor(color) {
  trackStudio?.pauseForManualControl();
  state.timelineCue = null;
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
  const musicActive = state.music.active;
  const scene = state.activeScene ? activeAdapter().scenes[state.activeScene] : null;
  const effect = state.activeCustomAnimation || scene;
  const factoryActive = state.activeFactoryIndex !== null;
  const color = musicActive
    ? state.music.color.toUpperCase()
    : factoryActive ? "#D9CFD5" : (effect?.color || selectedColor).toUpperCase();
  const brightness = (musicActive ? state.music.brightness : state.brightness) / 10;

  elements.lightstickVisual.style.setProperty("--light-color", color);
  elements.lightstickVisual.style.setProperty("--light-alpha", String(musicActive ? Math.max(0.08, brightness) : effect || factoryActive ? 1 : Math.max(0.08, brightness)));
  elements.lightstickVisual.dataset.effect = musicActive || factoryActive ? "solid" : effect?.previewEffect || "solid";
  elements.lightstickVisual.classList.toggle("is-off", !musicActive && (state.poweredOff || (!effect && !factoryActive && state.brightness === 0)));
  elements.colorSwatch.style.background = selectedColor;
  elements.hexValue.textContent = musicActive ? color : factoryActive ? `INDEX ${factoryIndexHex(state.activeFactoryIndex)}` : color;
  elements.brightnessValue.textContent = `${state.brightness} / 10`;
  elements.brightnessInput.style.setProperty("--progress", `${state.brightness * 10}%`);

  if (musicActive) {
    elements.previewMode.textContent = "Music";
    elements.previewName.textContent = MUSIC_MODE_LABELS[state.music.mode];
    elements.previewDescription.textContent = `Microphone reactive · brightness ${state.music.brightness}`;
  } else if (state.timelineCue) {
    elements.previewMode.textContent = "Track";
    elements.previewName.textContent = state.timelineCue.label || cueModeLabel(state.timelineCue.mode);
    elements.previewDescription.textContent = `Timeline cue at ${state.timelineCue.time.toFixed(2)} seconds`;
  } else if (factoryActive) {
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
    button.classList.toggle("active", !musicActive && !effect && !factoryActive && button.dataset.color.toUpperCase() === selectedColor);
  });
  elements.sceneButtons.forEach((button) => {
    button.classList.toggle("active", !musicActive && button.dataset.scene === state.activeScene);
  });
  updateAnimationBuilder();
}

function trackCuePacket(cue) {
  const adapter = activeAdapter();
  if (cue.mode === "off") return adapter.commands.powerOff();
  if (cue.mode === "solid") return adapter.commands.staticColor(cue.color, cue.brightness);
  const definition = adapter.customAnimations[cue.mode];
  if (!definition) throw new RangeError(`Unsupported timeline animation: ${cue.mode}`);
  return definition.packet({
    color: cue.color,
    speed: cue.speed,
    hue: cue.hue,
    animationId: cue.animationId,
    colorShift: cue.colorShift,
  });
}

function applyTrackCue(cue) {
  const definition = cue.mode === "off" || cue.mode === "solid" ? null : activeAdapter().customAnimations[cue.mode];
  state.timelineCue = cue;
  state.activeScene = null;
  state.activeFactoryIndex = null;
  state.color = cue.color;
  state.brightness = cue.brightness;
  state.poweredOff = cue.mode === "off" || (cue.mode === "solid" && cue.brightness === 0);
  state.activeCustomAnimation = definition ? {
    name: cue.label || cueModeLabel(cue.mode),
    description: `Track cue at ${cue.time.toFixed(2)} seconds`,
    previewEffect: definition.previewEffect,
    color: definition.usesColor ? cue.color : definition.previewColor,
  } : null;
  elements.colorInput.value = cue.color;
  updatePreview();

  if (!isConnected()) return Promise.resolve(false);
  const packet = trackCuePacket(cue);
  const label = `Track cue · ${cue.label || cueModeLabel(cue.mode)}`;
  timelineWriteChain = timelineWriteChain
    .catch(() => {})
    .then(async () => {
      if (!isConnected()) return false;
      addDiagnostic("TX", label, packet, "tx");
      await writeCharacteristic(packet);
      setCommandStatus("success", `${label} · ${packetLabel(packet)}`);
      return true;
    })
    .catch((error) => {
      console.error(error);
      addDiagnostic("ERR", `${label} failed: ${error.message || "Bluetooth write error"}`, null, "error");
      setCommandStatus("error", "Timeline cue failed. Playback continues.");
      return false;
    });
  return timelineWriteChain;
}

elements.connectButton.addEventListener("click", () => {
  if (isConnected()) disconnect();
  else connect();
});

elements.musicMode.addEventListener("change", (event) => {
  state.music.mode = event.target.value;
  state.music.lastPacketKey = "";
  updateMusicControls();
  if (state.music.active) updatePreview();
});

elements.musicSensitivityInput.addEventListener("input", (event) => {
  state.music.sensitivity = Number(event.target.value);
  updateMusicRanges();
});

elements.musicBrightnessInput.addEventListener("input", (event) => {
  state.music.maximumBrightness = Number(event.target.value);
  state.music.lastPacketKey = "";
  updateMusicRanges();
});

elements.startMusicButton.addEventListener("click", startMusicReactive);
elements.stopMusicButton.addEventListener("click", stopMusicAndRestore);

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
  trackStudio?.pauseForManualControl();
  state.timelineCue = null;
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
    const storedEntry = storedFactoryEntry(index);
    state.factoryPalette[String(index)] = { tested: true, label: storedEntry.label || "" };
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
  const storedEntry = storedFactoryEntry(index);
  if (!storedEntry.tested && !storedEntry.label) {
    showToast(FACTORY_MEMBER_PALETTE[index] ? "Only the provisional mapping is set" : "This index has no saved result");
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

elements.latencyRunProbesButton.addEventListener("click", runLatencyProbes);

elements.latencyCameraButton.addEventListener("click", async () => {
  if (state.latency.cameraTestActive) return;
  if (state.latency.cameraOn) {
    state.latency.cameraTracker?.stop();
    state.latency.guide?.setVisible(false);
    state.latency.cameraOn = false;
    elements.latencyFlashResult.textContent = "Camera is off";
    updateLatencyControls();
    return;
  }
  const supportError = cameraSupportMessage();
  if (supportError) {
    showToast(supportError);
    return;
  }
  if (!state.latency.cameraTracker) {
    // The flash test detects a brightness change (color → white), so it uses
    // the mean signal; the Blink Lab uses the 99th-percentile signal instead.
    state.latency.cameraTracker = new CameraLumaTracker({
      signal: "mean",
      onSample: cameraFlashSample,
      onEnded: () => {
        state.latency.guide?.setVisible(false);
        state.latency.cameraOn = false;
        elements.latencyFlashResult.textContent = "Camera input ended";
        updateLatencyControls();
      },
    });
    // The alignment circle and the analysis ROI are one and the same: the
    // flash detector watches the mean luma inside the circle only.
    state.latency.guide = new AlignmentGuide({
      frame: elements.latencyFlashFrame,
      hint: "Center the light in the circle · drag to move, pinch to resize",
      onRoiChange: (roi) => state.latency.cameraTracker?.setRoi(roi),
      onPositionChange: (x, y) => state.latency.cameraTracker?.setPosition(x, y),
    });
  }
  try {
    await state.latency.cameraTracker.start(elements.latencyFlashVideo);
    state.latency.guide?.setVisible(true);
    state.latency.cameraOn = true;
    elements.latencyFlashResult.textContent = "Camera on — center it in the circle";
    updateLatencyControls();
  } catch (error) {
    const message = cameraErrorMessage(error);
    elements.latencyFlashResult.textContent = message;
    showToast(message);
  }
});

elements.latencyFlashButton.addEventListener("click", runCameraFlashTest);

elements.latencyGuideReset.addEventListener("click", () => state.latency.guide?.reset());

elements.latencyTapButton.addEventListener("click", () => {
  if (state.latency.flashStartedAt != null) {
    const ms = performance.now() - state.latency.flashStartedAt;
    state.latency.flashStartedAt = null;
    state.latency.tapActive = false;
    window.clearTimeout(state.latency.tapTimeout);
    state.latency.taps.push(ms);
    restoreLatencyFlash();
    renderLatencyTapResult();
    elements.latencyTapButton.classList.remove("armed");
    elements.latencyTapButton.textContent = "Start test";
    updateLatencyControls();
  } else {
    startLatencyTapTest();
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

trackStudio = new TrackStudio({
  root: document.querySelector("#trackStudio"),
  onCue: applyTrackCue,
  onPlaybackChange: (playing) => {
    if (!playing) return;
    if (state.music.active || state.music.starting) stopMusicReactive("Stopped by track playback");
    setCommandStatus(null, isConnected()
      ? "Track playback is controlling the connected lightstick"
      : "Track playback is running as a visual preview");
  },
  onNotice: showToast,
});

blinkLab = new BlinkLab({
  root: document.querySelector("#blinkLabPanel"),
  getConnected: isConnected,
  getColor: () => state.color,
  onColorChange: selectSolidColor,
  sendBlink: async (color, speed, label) => {
    if (!isConnected()) {
      showToast("Connect your Candybong first");
      return false;
    }
    const definition = activeAdapter().customAnimations.blink;
    const packet = definition.packet({ color, speed });
    if (await sendPacket(packet, label)) {
      state.activeScene = null;
      state.activeFactoryIndex = null;
      state.activeCustomAnimation = {
        name: definition.name,
        description: `Speed ${speed} · set from Blink Lab`,
        previewEffect: definition.previewEffect,
        color,
      };
      state.poweredOff = false;
      updatePreview();
      return true;
    }
    return false;
  },
  onDiagnostic: addDiagnostic,
  onToast: showToast,
});

captureLab = new CaptureGuide({
  root: document.querySelector("#captureLabPanel"),
  onDiagnostic: addDiagnostic,
  onToast: showToast,
  // onCapture: future detection plugs in here
});

loadFactoryPalette();
renderFactoryPalette();
updateFactorySelection();
renderDiagnostics();
updatePreview();
setConnectionStatus(false);
initializeSupportMessage();
