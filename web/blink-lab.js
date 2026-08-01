// Blink Lab: measures the lightstick's real blink frequency with the webcam and
// calibrates the firmware speed value (0–255, undocumented relationship to real
// frequency) against measured blinks per minute. Pure math is exported for node
// --test; the BlinkLab class owns the panel DOM via data-blinklab attributes.

import { CameraLumaTracker, cameraErrorMessage, cameraSupportMessage } from "./camera-luma.js";

export const SWEEP_SPEEDS = [10, 40, 100, 180, 255];
export const SWEEP_CYCLES_NEEDED = 5;
export const SWEEP_STEP_TIMEOUT_MIN_MS = 30000;
const SWEEP_TIMEOUT_CYCLE_MARGIN = 1.5;
const SWEEP_TIMEOUT_EXTRA_MS = 2000;
const DARK_COLOR_LUMA_MAX = 55;

// Per-row timeout for the sweep. A row needs one anchor blink plus one period
// per measured cycle, so a slow blink (high speed value) needs a long window:
// period * (cycles + 1) with margin. Slow rows extend the deadline on the fly
// as periods arrive; this function sizes the initial window from a known or
// estimated period, with a floor so fast rows still get a sane wait.
export function stepTimeoutMs(periodMs) {
  const duration = periodMs * (SWEEP_CYCLES_NEEDED + 1) * SWEEP_TIMEOUT_CYCLE_MARGIN + SWEEP_TIMEOUT_EXTRA_MS;
  return Math.max(SWEEP_STEP_TIMEOUT_MIN_MS, duration);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function averagePeriodMs(samples) {
  return median(samples);
}

export function blinksPerMinute(periodMs) {
  if (periodMs == null || periodMs <= 0) return null;
  return Math.round(60000 / periodMs);
}

// Perceived luminance of a hex color as a 0–255 value, for the "too dark to
// detect" warning. Uses Rec. 709 coefficients.
export function lumaOfHex(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 255;
  const channel = (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  const red = channel(1);
  const green = channel(3);
  const blue = channel(5);
  return Math.round((0.2126 * red + 0.7152 * green + 0.0722 * blue) * 255);
}

// Least-squares line through measured (speed, periodMs) points.
export function linearFit(points) {
  const usable = points.filter((point) => Number.isFinite(point.speed) && Number.isFinite(point.periodMs));
  if (usable.length < 2) return { slope: null, intercept: null, rSquared: null, valid: false, points: usable.length };

  const count = usable.length;
  const meanX = usable.reduce((sum, point) => sum + point.speed, 0) / count;
  const meanY = usable.reduce((sum, point) => sum + point.periodMs, 0) / count;
  let ssxx = 0;
  let ssxy = 0;
  let ssyy = 0;
  for (const point of usable) {
    const dx = point.speed - meanX;
    const dy = point.periodMs - meanY;
    ssxx += dx * dx;
    ssxy += dx * dy;
    ssyy += dy * dy;
  }
  if (ssxx === 0) return { slope: null, intercept: null, rSquared: null, valid: false, points: usable.length };

  const slope = ssxy / ssxx;
  const intercept = meanY - slope * meanX;
  const rSquared = ssyy === 0 ? 1 : (ssxy * ssxy) / (ssxx * ssyy);
  return { slope, intercept, rSquared, valid: true, points: usable.length };
}

// Inverse of the fit: which speed produces the target blinks/min, clamped to
// the firmware range. Null when the fit is unusable or the target is invalid.
export function speedForTargetBpm(fit, targetBpm) {
  if (!fit?.valid || fit.slope === 0 || targetBpm == null || !(targetBpm > 0)) return null;
  const periodMs = 60000 / targetBpm;
  return Math.min(255, Math.max(0, Math.round((periodMs - fit.intercept) / fit.slope)));
}

// Built-in speed↔rate mapping, used until the user runs their own sweep. It is
// the exact inverse of the piecewise model fitted to observed candybong
// behaviour: a shifted rational decay over speeds 0–50 (617 → 12 blinks/min)
// and a log-linear tail over speeds 50–255 (12 → 3 blinks/min).
export function defaultSpeedForBpm(targetBpm) {
  if (targetBpm == null || !(targetBpm > 0)) return null;
  if (targetBpm >= 12) {
    // Inverse of B(s) = 3 + 614 / (1 + (s/5.011)^1.829), speeds 0–50.
    const ratio = 614 / (targetBpm - 3) - 1;
    if (!(ratio > 0)) return 0;
    return Math.min(50, Math.max(0, Math.round(5.011 * Math.pow(ratio, 1 / 1.829))));
  }
  // Inverse of B(s) = 12 * (1/4)^((s-50)/205), speeds 50–255.
  return Math.min(255, Math.max(50, Math.round(50 + (205 * Math.log(12 / targetBpm)) / Math.log(4))));
}

// Consumes one period per blink cycle during a sweep step; the first edge after
// creation anchors the measurement, so only the following cycles count.
export function createSweepMeasurement(cyclesNeeded = SWEEP_CYCLES_NEEDED) {
  let count = 0;
  const periods = [];
  return {
    get done() {
      return count >= cyclesNeeded;
    },
    addPeriod(periodMs) {
      if (this.done) return { done: true, medianPeriodMs: averagePeriodMs(periods) };
      if (periodMs == null || periodMs <= 0) return { done: false, medianPeriodMs: null };
      periods.push(periodMs);
      count += 1;
      return { done: this.done, medianPeriodMs: this.done ? averagePeriodMs(periods) : null };
    },
  };
}

const STATE_MESSAGES = {
  waiting: { title: "Waiting for signal", detail: "Point the camera at the lightstick" },
  bright: { title: "Light is on", detail: "Frame brightness is above the threshold" },
  dark: { title: "Light is off", detail: "Frame brightness is below the threshold" },
  "no-signal": { title: "No brightness change", detail: "Nothing lit is moving in frame — light off or steady" },
  solid: { title: "Blinking stopped", detail: "No edges for a few seconds — the light may have gone steady" },
};

const ROW_RESULTS = {
  pending: "Pending",
  measuring: "Measuring…",
  ok: "OK",
  timeout: "Timeout",
  stopped: "Stopped",
};

const ELEMENT_NAMES = [
  "status",
  "color",
  "colorSwatch",
  "colorHex",
  "speed",
  "speedValue",
  "applySpeed",
  "startCamera",
  "stopCamera",
  "preview",
  "analysis",
  "stateDot",
  "signalState",
  "signalDetail",
  "lumaMeter",
  "lumaFill",
  "lumaValue",
  "blinkCount",
  "latestPeriod",
  "medianRate",
  "startSweep",
  "stopSweep",
  "sweepSummary",
  "table",
  "tableBody",
  "fitLine",
  "target",
  "targetValue",
  "targetLine",
  "mappingLabel",
  "resetMapping",
  "applyTarget",
];

export class BlinkLab {
  constructor({ root, getConnected, getColor, onColorChange, sendBlink, onDiagnostic, onToast }) {
    if (!root) throw new Error("Blink Lab root element is missing");
    this.root = root;
    this.getConnected = getConnected;
    this.getColor = getColor;
    this.onColorChange = onColorChange;
    this.sendBlink = sendBlink;
    this.onDiagnostic = onDiagnostic;
    this.onToast = onToast;

    this.elements = Object.fromEntries(ELEMENT_NAMES.map((name) => [name, root.querySelector(`[data-blinklab="${name}"]`)]));
    this.cameraOn = false;
    this.blinkCount = 0;
    this.periods = [];
    this.lastRiseAt = null;
    this.sweep = null;
    this.fit = null;
    this.mapping = "default"; // "default" (built-in formula) | "sweep" (own fit)
    this.tracker = new CameraLumaTracker({
      signal: "bright",
      onSample: (sample) => this.handleSample(sample),
      onEnded: () => this.stopCamera("Camera input ended"),
    });
    this.cameraStartedAt = null;

    this.bindEvents();
    this.resetStats();
    this.elements.color.value = getColor?.() || "#ff5fa2";
    this.updateColorDisplay();
    this.updateSpeedDisplay();
    this.setStatus("Camera off", null);
    this.render();
  }

  bindEvents() {
    const elements = this.elements;
    elements.color.addEventListener("input", (event) => {
      this.onColorChange?.(event.target.value);
      this.updateColorDisplay();
    });
    elements.speed.addEventListener("input", () => this.updateSpeedDisplay());
    elements.applySpeed.addEventListener("click", () => this.handleApplySpeed());
    elements.startCamera.addEventListener("click", () => this.startCamera());
    elements.stopCamera.addEventListener("click", () => this.stopCamera());
    elements.startSweep.addEventListener("click", () => this.startSweep());
    elements.stopSweep.addEventListener("click", () => this.cancelSweep("Sweep stopped by user"));
    elements.target.addEventListener("input", () => this.updateTargetLine());
    elements.applyTarget.addEventListener("click", () => this.handleApplyTarget());
    elements.resetMapping.addEventListener("click", () => this.handleResetMapping());
  }

  setStatus(message, style = null) {
    this.elements.status.textContent = message;
    this.elements.status.classList.remove("listening", "warning");
    if (style) this.elements.status.classList.add(style);
  }

  setConnected(connected) {
    this.render();
    this.updateTargetLine();
  }

  onDisconnected() {
    this.cancelSweep("Sweep stopped because the lightstick disconnected");
    this.render();
  }

  updateColorDisplay() {
    const color = this.elements.color.value.toUpperCase();
    this.elements.colorSwatch.style.background = color;
    this.elements.colorHex.textContent = color;
  }

  updateSpeedDisplay() {
    const speed = Number(this.elements.speed.value);
    this.elements.speedValue.textContent = `${speed} / 255`;
    this.elements.applySpeed.textContent = `Blink at speed ${speed}`;
  }

  resetStats() {
    this.blinkCount = 0;
    this.periods = [];
    this.lastRiseAt = null;
    this.elements.blinkCount.textContent = "0";
    this.elements.latestPeriod.textContent = "—";
    this.elements.medianRate.textContent = "—";
  }

  handleSample({ luma, state, edge, edgeAt, swing, lastEdgeAt, timeMs }) {
    const percent = Math.round((luma / 255) * 100);
    this.elements.lumaMeter.setAttribute("aria-valuenow", String(percent));
    this.elements.lumaFill.style.width = `${percent}%`;
    this.elements.lumaValue.textContent = `${percent}%`;

    const dot = this.elements.stateDot;
    dot.classList.remove("listening", "starting");
    if (state === "bright") dot.classList.add("listening");
    if (state === "waiting") dot.classList.add("starting");
    const message = STATE_MESSAGES[state] || STATE_MESSAGES.waiting;
    this.elements.signalState.textContent = message.title;
    let detail = message.detail;
    if (
      state === "waiting"
      && lastEdgeAt === null
      && swing > 60
      && this.cameraStartedAt !== null
      && timeMs - this.cameraStartedAt > 3000
      && this.periods.length === 0
    ) {
      detail = "The light is changing faster than the camera can see — try a slower speed";
    }
    this.elements.signalDetail.textContent = detail;

    if (edge === "rise") {
      this.recordRise(edgeAt);
      if (this.sweep?.running) this.stepSweepMeasurement();
    }
  }

  recordRise(at) {
    if (this.lastRiseAt !== null) {
      const periodMs = at - this.lastRiseAt;
      this.periods.push(periodMs);
      this.elements.latestPeriod.textContent = `${Math.round(periodMs)} ms`;
    }
    this.lastRiseAt = at;
    this.blinkCount += 1;
    this.elements.blinkCount.textContent = String(this.blinkCount);
    const medianPeriod = averagePeriodMs(this.periods);
    this.elements.medianRate.textContent = medianPeriod == null ? "—" : `${blinksPerMinute(medianPeriod)}/min`;
  }

  async startCamera() {
    const support = cameraSupportMessage();
    if (support) {
      this.onToast?.(support);
      return;
    }
    try {
      await this.tracker.start(this.elements.preview);
      this.cameraOn = true;
      this.cameraStartedAt = performance.now();
      this.elements.analysis.hidden = false;
      this.resetStats();
      this.setStatus("Camera on · measuring", "listening");
      this.onDiagnostic?.("SYS", "Blink Lab camera started", null, "status");
    } catch (error) {
      this.onToast?.(cameraErrorMessage(error));
    }
    this.render();
  }

  stopCamera(message = null) {
    const wasOn = this.cameraOn;
    this.tracker.stop();
    this.cameraOn = false;
    this.cameraStartedAt = null;
    this.elements.analysis.hidden = true;
    this.setStatus("Camera off", null);
    this.render();
    if (wasOn) {
      this.cancelSweep("Sweep stopped because the camera stopped");
      if (message) {
        this.onToast?.(message);
        this.onDiagnostic?.("SYS", message, null, "status");
      }
    }
  }

  async handleApplySpeed() {
    if (!this.getConnected?.()) {
      this.onToast?.("Connect your Candybong first");
      return;
    }
    const color = this.elements.color.value;
    const speed = Number(this.elements.speed.value);
    this.resetStats();
    if (await this.sendBlink(color, speed, `Blink Lab · speed ${speed}`)) {
      this.setStatus(`Measuring · speed ${speed}`, "listening");
      if (lumaOfHex(color) < DARK_COLOR_LUMA_MAX) {
        this.onToast?.("This dark color is hard for the camera to detect — try a brighter color");
      }
    }
  }

  async startSweep() {
    if (!this.getConnected?.()) {
      this.onToast?.("Connect your Candybong first");
      return;
    }
    if (this.sweep?.running) return;
    if (!this.cameraOn) {
      this.onToast?.("Start the camera first");
      return;
    }
    this.fit = null;
    this.sweep = {
      running: true,
      rows: SWEEP_SPEEDS.map((speed) => ({ speed, state: "pending", periodMs: null })),
      index: 0,
      measurement: null,
      timeout: null,
      deadline: 0,
      lastPeriodMs: null,
      color: this.elements.color.value,
    };
    this.elements.sweepSummary.textContent = "Sweeping…";
    this.render();
    await this.runSweepStep(0);
  }

  async runSweepStep(index) {
    if (!this.sweep?.running) return;
    this.sweep.index = index;
    const row = this.sweep.rows[index];
    row.state = "measuring";
    this.renderSweepTable();
    this.resetStats();
    const sent = await this.sendBlink(this.sweep.color, row.speed, `Blink Lab sweep ${index + 1} of ${SWEEP_SPEEDS.length}`);
    if (!sent) {
      this.cancelSweep("Sweep stopped because the command could not be sent");
      return;
    }
    if (!this.sweep?.running) return;
    // Measure only after the write lands: cycles before it still ran at the
    // previous speed, and the reset makes the first rise the anchor.
    this.resetStats();
    this.sweep.measurement = createSweepMeasurement(SWEEP_CYCLES_NEEDED);
    // Higher speed values blink slower, and the sweep runs fast-to-slow, so
    // the previous measured row is a lower bound on this row's period. Slow
    // rows extend the deadline further as their periods arrive.
    const estimate = this.sweep.lastPeriodMs;
    const initialTimeout = estimate == null ? SWEEP_STEP_TIMEOUT_MIN_MS : stepTimeoutMs(estimate);
    this.sweep.deadline = performance.now() + initialTimeout;
    this.sweep.timeout = window.setTimeout(() => this.finishSweepStep(index, null, "timeout"), initialTimeout);
    this.setStatus(`Sweep ${index + 1}/${SWEEP_SPEEDS.length} · speed ${row.speed}`, "listening");
  }

  stepSweepMeasurement() {
    const measurement = this.sweep?.measurement;
    if (!measurement || measurement.done) return;
    const latest = this.periods.length ? this.periods[this.periods.length - 1] : null;
    if (latest != null) this.extendSweepDeadline(latest);
    const result = measurement.addPeriod(latest);
    if (result.done) this.finishSweepStep(this.sweep.index, result.medianPeriodMs, "ok");
  }

  // Once the real blink rate is known, the deadline grows to cover the cycles
  // still needed (one anchor blink plus one period per cycle, with margin).
  extendSweepDeadline(periodMs) {
    const deadline = performance.now() + stepTimeoutMs(periodMs);
    if (deadline <= this.sweep.deadline) return;
    this.sweep.deadline = deadline;
    window.clearTimeout(this.sweep.timeout);
    this.sweep.timeout = window.setTimeout(
      () => this.finishSweepStep(this.sweep.index, null, "timeout"),
      deadline - performance.now(),
    );
  }

  finishSweepStep(index, medianPeriodMs, outcome) {
    if (!this.sweep?.running || this.sweep.index !== index) return;
    window.clearTimeout(this.sweep.timeout);
    const row = this.sweep.rows[index];
    if (outcome === "timeout") {
      row.state = "timeout";
    } else {
      row.periodMs = medianPeriodMs;
      row.state = "ok";
      this.sweep.lastPeriodMs = medianPeriodMs;
    }
    this.renderSweepTable();
    const next = index + 1;
    if (next >= this.sweep.rows.length) this.finishSweep();
    else this.runSweepStep(next);
  }

  finishSweep() {
    if (!this.sweep?.running) return;
    this.sweep.running = false;
    window.clearTimeout(this.sweep.timeout);
    const measured = this.sweep.rows
      .filter((row) => row.state === "ok")
      .map((row) => ({ speed: row.speed, periodMs: row.periodMs }));
    this.fit = linearFit(measured);
    if (this.fit.valid) this.mapping = "sweep";
    this.renderSweepTable();
    this.renderFitLine();
    this.updateTargetLine();
    this.setStatus("Sweep complete", null);
    this.onDiagnostic?.(
      "SYS",
      this.fit.valid
        ? `Blink Lab sweep: ${this.fit.points} rows · R² ${this.fit.rSquared.toFixed(3)}`
        : "Blink Lab sweep: fewer than two measured rows",
      null,
      "status",
    );
    this.render();
  }

  cancelSweep(message = null) {
    if (!this.sweep?.running) return;
    this.sweep.running = false;
    window.clearTimeout(this.sweep.timeout);
    for (const row of this.sweep.rows) {
      if (row.state === "pending" || row.state === "measuring") row.state = "stopped";
    }
    this.renderSweepTable();
    this.setStatus("Sweep stopped", "warning");
    this.render();
    if (message) this.onToast?.(message);
  }

  renderSweepTable() {
    if (!this.sweep) return;
    this.elements.table.hidden = false;
    this.elements.tableBody.replaceChildren();
    for (const row of this.sweep.rows) {
      const tr = document.createElement("tr");
      tr.className = row.state === "ok" ? "" : row.state;
      const speed = document.createElement("td");
      speed.textContent = String(row.speed);
      const period = document.createElement("td");
      period.textContent = row.periodMs == null ? "—" : `${Math.round(row.periodMs)} ms`;
      const rate = document.createElement("td");
      rate.textContent = row.periodMs == null ? "—" : `${blinksPerMinute(row.periodMs)}/min`;
      const result = document.createElement("td");
      result.textContent = ROW_RESULTS[row.state] || row.state;
      tr.append(speed, period, rate, result);
      this.elements.tableBody.append(tr);
    }
  }

  renderFitLine() {
    const fit = this.fit;
    if (!fit?.valid) {
      this.elements.fitLine.textContent = "Add at least two measured rows to fit a period-vs-speed line.";
      return;
    }
    const sign = fit.slope >= 0 ? "+" : "−";
    this.elements.fitLine.textContent =
      `period(ms) = ${sign}${Math.abs(fit.slope).toFixed(1)} × speed ${Math.round(fit.intercept)}` +
      ` · R² = ${fit.rSquared.toFixed(3)}`;
  }

  // Which speed a target rate maps to: the sweep fit when one is active and
  // usable, otherwise the built-in formula.
  targetSpeed(targetBpm) {
    if (this.mapping === "sweep" && this.fit?.valid) {
      const speed = speedForTargetBpm(this.fit, targetBpm);
      if (speed != null) return { speed, sourceLabel: `Sweep fit (${this.fit.points} rows · R² ${this.fit.rSquared.toFixed(2)})` };
    }
    const speed = defaultSpeedForBpm(targetBpm);
    return { speed, sourceLabel: "Built-in formula" };
  }

  updateTargetLine() {
    const target = Number(this.elements.target.value);
    this.elements.targetValue.textContent = String(target);
    const { speed, sourceLabel } = this.targetSpeed(target);
    const fitted = this.mapping === "sweep" && this.fit?.valid;
    this.elements.mappingLabel.textContent = fitted
      ? `Mapping: sweep fit (${this.fit.points} rows · R² ${this.fit.rSquared.toFixed(2)})`
      : "Mapping: built-in formula";
    this.elements.resetMapping.disabled = !fitted;
    if (speed == null) {
      this.elements.targetLine.textContent = "Enter a positive target rate to compute a speed.";
      this.elements.applyTarget.disabled = true;
      return;
    }
    this.elements.targetLine.textContent = `${sourceLabel}: target ${target} blinks/min → speed ${speed}`;
    this.elements.applyTarget.disabled = !(this.getConnected?.() ?? false);
  }

  handleResetMapping() {
    if (this.mapping === "default") return;
    this.mapping = "default";
    this.updateTargetLine();
    this.onToast?.("Using the built-in formula");
    this.onDiagnostic?.("SYS", "Blink Lab mapping reset to the built-in formula", null, "status");
  }

  async handleApplyTarget() {
    if (!this.getConnected?.()) {
      this.onToast?.("Connect your Candybong first");
      return;
    }
    const target = Number(this.elements.target.value);
    const { speed } = this.targetSpeed(target);
    if (speed == null) return;
    const color = this.elements.color.value;
    this.resetStats();
    if (await this.sendBlink(color, speed, `Blink Lab target · ${target} blinks/min`)) {
      this.setStatus(`Applying speed ${speed}`, null);
    }
  }

  render() {
    const connected = this.getConnected?.() ?? false;
    const sweeping = Boolean(this.sweep?.running);
    this.elements.applySpeed.disabled = !connected || sweeping;
    this.elements.startCamera.disabled = this.cameraOn || sweeping;
    this.elements.stopCamera.disabled = !this.cameraOn;
    this.elements.startSweep.disabled = !connected || !this.cameraOn || sweeping;
    this.elements.stopSweep.disabled = !sweeping;
    this.elements.speed.disabled = sweeping;
    this.elements.color.disabled = sweeping;
    this.updateTargetLine();
  }
}
