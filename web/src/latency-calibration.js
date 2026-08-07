import { captureSourceRect, createEdgeDetector } from "./camera-luma.js";

export const CALIBRATION_REPETITIONS = 20;
export const CALIBRATION_MIN_VALID_TRIALS = 15;

const WHITE = "#ffffff";
const CAMERA_WIDTH = 64;
const CAMERA_HEIGHT = 64;
const CAMERA_ROI_FRACTION = 0.7;
const SENSOR_WARMUP_MS = 1200;
const TRIAL_TIMEOUT_MS = 3500;
const DARK_SETTLE_TIMEOUT_MS = 1200;
const BRIGHT_SETTLE_TIMEOUT_MS = 1800;
const DARK_MARGIN = 6;
const BRIGHT_MARGIN = 10;

function profile(id, label, packet, options = {}) {
  return {
    id,
    label,
    packet,
    direction: options.direction || "rise",
    preparation: options.preparation || "dark",
    expectedResponse: options.expectedResponse || null,
    includeInGlobal: options.includeInGlobal !== false,
    timeoutMs: options.timeoutMs || TRIAL_TIMEOUT_MS,
  };
}

export function createCalibrationProfiles(adapter) {
  const profiles = [
    profile(
      "solid.on",
      "Solid color on",
      adapter.commands.staticColor(WHITE, 10),
    ),
    profile(
      "solid.off",
      "Solid color off",
      adapter.commands.powerOff(),
      { direction: "fall", preparation: "lit" },
    ),
  ];

  return profiles;
}

export function rms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function createAudioImpulseDetector({ minRms = 0.018, noiseMultiplier = 4, confirmMs = 12 } = {}) {
  let noiseFloor = minRms / noiseMultiplier;
  let pending = null;
  let triggered = false;

  return {
    arm() {
      pending = null;
      triggered = false;
    },

    step(level, timeMs) {
      const threshold = Math.max(minRms, noiseFloor * noiseMultiplier + 0.006);
      if (!triggered && level > threshold) {
        if (!pending) pending = { crossedAt: timeMs };
        if (timeMs - pending.crossedAt >= confirmMs) {
          triggered = true;
          const edgeAt = pending.crossedAt;
          pending = null;
          return { edge: "rise", edgeAt };
        }
      } else if (!triggered) {
        pending = null;
        noiseFloor = Math.max(minRms / noiseMultiplier, noiseFloor * 0.98 + level * 0.02);
      }
      return { edge: null, edgeAt: null };
    },
  };
}

export function createLumaChangeDetector({ minDelta = 8, confirmMs = 50 } = {}) {
  let baseline = null;
  let pending = null;
  let triggered = false;

  return {
    arm(value) {
      baseline = value;
      pending = null;
      triggered = false;
    },

    step(value, timeMs) {
      if (baseline == null || triggered) return { edge: null, edgeAt: null };
      if (Math.abs(value - baseline) >= minDelta) {
        if (!pending) pending = { crossedAt: timeMs };
        if (timeMs - pending.crossedAt >= confirmMs) {
          triggered = true;
          const edgeAt = pending.crossedAt;
          pending = null;
          return { edge: "change", edgeAt };
        }
      } else {
        pending = null;
      }
      return { edge: null, edgeAt: null };
    },
  };
}

function sortedFinite(values) {
  return values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
}

export function percentile(values, fraction = 0.95) {
  const sorted = sortedFinite(values);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values) {
  return percentile(values, 0.5);
}

function metricStats(trials, field) {
  const values = trials.map((trial) => trial[field]).filter((value) => Number.isFinite(value));
  return {
    medianMs: median(values),
    p95Ms: percentile(values, 0.95),
    minMs: values.length ? Math.min(...values) : null,
    maxMs: values.length ? Math.max(...values) : null,
  };
}

export function summarizeCalibrationProfile(profileDefinition, trials) {
  const validTrials = trials.filter((trial) => trial.valid);
  const stats = {
    soundToLight: metricStats(validTrials, "soundToLightMs"),
    commandToLight: metricStats(validTrials, "commandToLightMs"),
    write: metricStats(validTrials, "writeMs"),
    reply: metricStats(validTrials, "replyMs"),
  };
  const replyCount = validTrials.filter((trial) => Number.isFinite(trial.replyMs)).length;
  return {
    id: profileDefinition.id,
    label: profileDefinition.label,
    packet: [...profileDefinition.packet],
    direction: profileDefinition.direction,
    includeInGlobal: profileDefinition.includeInGlobal,
    sampleCount: trials.length,
    validCount: validTrials.length,
    invalidCount: trials.length - validTrials.length,
    replyCount,
    eligibleForGlobal: profileDefinition.includeInGlobal && validTrials.length >= CALIBRATION_MIN_VALID_TRIALS,
    stats,
    trials,
  };
}

export function buildCalibrationReport({ profiles, trialsByProfile, metadata = {} }) {
  const profileReports = profiles.map((definition) => summarizeCalibrationProfile(
    definition,
    trialsByProfile[definition.id] || [],
  ));
  const validSoundToLight = profileReports.flatMap((report) => report.trials)
    .filter((trial) => trial.valid && Number.isFinite(trial.soundToLightMs))
    .map((trial) => trial.soundToLightMs);
  return {
    schema: "candybong-sound-to-light-calibration",
    version: 1,
    capturedAt: new Date().toISOString(),
    metadata,
    profileReports,
    global: {
      medianSoundToLightMs: median(validSoundToLight),
      validSampleCount: validSoundToLight.length,
      statistic: "median",
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class LatencyCalibrationSession {
  constructor({
    video,
    profiles,
    powerOffPacket,
    litBaselinePacket,
    repetitions = CALIBRATION_REPETITIONS,
    writeCommand,
    isConnected,
    onProgress,
    onSensorStatus,
    metadata,
    positionX = 0.5,
    positionY = 0.5,
    roiFraction = CAMERA_ROI_FRACTION,
  }) {
    this.video = video;
    this.profiles = profiles;
    this.powerOffPacket = powerOffPacket;
    this.litBaselinePacket = litBaselinePacket;
    this.repetitions = repetitions;
    this.writeCommand = writeCommand;
    this.isConnected = isConnected;
    this.onProgress = onProgress;
    this.onSensorStatus = onSensorStatus;
    this.metadata = metadata;
    this.positionX = positionX;
    this.positionY = positionY;
    this.roiFraction = roiFraction;
    this.cancelled = false;
    this.active = false;
    this.stream = null;
    this.audioContext = null;
    this.audioSource = null;
    this.audioAnalyser = null;
    this.audioSamples = null;
    this.canvas = null;
    this.context = null;
    this.animationFrame = null;
    this.sensorMetadata = null;
    this.latestLuma = null;
    this.darkReference = null;
    this.cameraDetector = createEdgeDetector({ windowFrames: 45, minSwing: 8, marginFraction: 0.1, confirmMs: 50 });
    this.changeDetector = createLumaChangeDetector();
    this.audioDetector = createAudioImpulseDetector();
    this.pendingTrial = null;
    this.sample = this.sample.bind(this);
  }

  cancel() {
    this.cancelled = true;
    if (this.pendingTrial) this.pendingTrial.resolve(null);
  }

  async startPreview() {
    if (this.active) return;
    if (!this.isConnected()) throw new Error("The Candybong is not connected");
    this.cancelled = false;
    this.active = true;
    try {
      await this.startSensors();
    } catch (error) {
      await this.stopSensors();
      this.active = false;
      throw error;
    }
  }

  async stopPreview() {
    if (!this.active) return;
    this.cancel();
    await this.stopSensors();
    this.active = false;
  }

  getStream() {
    return this.stream;
  }

  setRoi(fraction) {
    this.roiFraction = Math.max(0.01, Math.min(1, fraction));
  }

  setPosition(positionX, positionY) {
    this.positionX = Math.max(0, Math.min(1, positionX));
    this.positionY = Math.max(0, Math.min(1, positionY));
  }

  async run() {
    if (!this.isConnected()) throw new Error("The Candybong is not connected");
    this.cancelled = false;
    const sensorsAlreadyStarted = this.active;
    this.active = true;
    const trialsByProfile = Object.fromEntries(this.profiles.map((definition) => [definition.id, []]));
    try {
      if (!sensorsAlreadyStarted) await this.startSensors();
      await this.prepareDarkReference();
      const total = this.profiles.length * this.repetitions;
      let completed = 0;
      for (const definition of this.profiles) {
        for (let repetition = 0; repetition < this.repetitions; repetition += 1) {
          if (this.cancelled || !this.isConnected()) throw new Error("Calibration cancelled or disconnected");
          const trial = await this.runTrial(definition);
          trialsByProfile[definition.id].push(trial);
          completed += 1;
          this.onProgress?.({ definition, repetition: repetition + 1, repetitions: this.repetitions, completed, total });
        }
      }
      return buildCalibrationReport({
        profiles: this.profiles,
        trialsByProfile,
        metadata: { ...this.metadata, sensors: this.sensorMetadata },
      });
    } finally {
      await this.stopSensors();
      this.active = false;
    }
  }

  async startSensors() {
    this.onSensorStatus?.("Requesting camera and microphone…");
    if (!globalThis.isSecureContext) throw new Error("Camera and microphone access needs HTTPS or localhost");
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error("This browser does not expose camera and microphone input");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", frameRate: { ideal: 60 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (error) {
      if (error?.name !== "OverconstrainedError") throw error;
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
    this.stream = stream;
    const videoSettings = stream.getVideoTracks()[0]?.getSettings?.() || {};
    const audioSettings = stream.getAudioTracks()[0]?.getSettings?.() || {};
    this.sensorMetadata = {
      video: {
        width: videoSettings.width,
        height: videoSettings.height,
        frameRate: videoSettings.frameRate,
      },
      audio: {
        sampleRate: audioSettings.sampleRate,
        channelCount: audioSettings.channelCount,
      },
    };
    this.video.srcObject = stream;
    this.video.hidden = false;
    this.video.play().catch(() => {});
    this.canvas = document.createElement("canvas");
    this.canvas.width = CAMERA_WIDTH;
    this.canvas.height = CAMERA_HEIGHT;
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is unavailable");
    this.audioContext = new AudioContextClass();
    await this.audioContext.resume();
    this.audioSource = this.audioContext.createMediaStreamSource(stream);
    this.audioAnalyser = this.audioContext.createAnalyser();
    // Keep the microphone window short; the camera frame interval remains the
    // dominant measurement quantization, while a 1024-sample window would add
    // an avoidable ~21 ms delay at a 48 kHz input rate.
    this.audioAnalyser.fftSize = 256;
    this.audioSamples = new Float32Array(this.audioAnalyser.fftSize);
    this.audioSource.connect(this.audioAnalyser);
    this.animationFrame = window.requestAnimationFrame(this.sample);
    this.onSensorStatus?.("Warming up camera and microphone…");
    await wait(SENSOR_WARMUP_MS);
  }

  async stopSensors() {
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.audioSource?.disconnect();
    this.audioAnalyser?.disconnect();
    if (this.audioContext) await this.audioContext.close().catch(() => {});
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.video) {
      this.video.srcObject = null;
      this.video.hidden = true;
    }
    this.stream = null;
    this.audioContext = null;
    this.audioSource = null;
    this.audioAnalyser = null;
    this.audioSamples = null;
    this.canvas = null;
    this.context = null;
  }

  sample(now) {
    if (!this.active || !this.video || !this.context || !this.audioAnalyser) return;
    if (this.video.readyState >= 2) {
      const sourceRect = captureSourceRect(
        this.video.videoWidth,
        this.video.videoHeight,
        this.roiFraction,
        this.positionX,
        this.positionY,
      );
      if (sourceRect) {
        this.context.drawImage(this.video, sourceRect.sx, sourceRect.sy, sourceRect.side, sourceRect.side, 0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
        const pixels = this.context.getImageData(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT).data;
        const centerX = CAMERA_WIDTH / 2;
        const centerY = CAMERA_HEIGHT / 2;
        const radius = Math.min(centerX, centerY);
        let maskedPixels = 0;
        let total = 0;
        for (let y = 0; y < CAMERA_HEIGHT; y += 1) {
          for (let x = 0; x < CAMERA_WIDTH; x += 1) {
            const dx = x + 0.5 - centerX;
            const dy = y + 0.5 - centerY;
            if (dx * dx + dy * dy > radius * radius) continue;
            const index = (y * CAMERA_WIDTH + x) * 4;
            total += pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
            maskedPixels += 1;
          }
        }
        this.latestLuma = maskedPixels ? total / maskedPixels : 0;
        const cameraResult = this.cameraDetector.step(this.latestLuma, now);
        const changeResult = this.changeDetector.step(this.latestLuma, now);
        this.handleSensorEvent(cameraResult, changeResult);
      }
    }
    this.audioAnalyser.getFloatTimeDomainData(this.audioSamples);
    const audioResult = this.audioDetector.step(rms(this.audioSamples), now);
    this.handleAudioEvent(audioResult);
    this.animationFrame = window.requestAnimationFrame(this.sample);
  }

  handleSensorEvent(cameraResult, changeResult) {
    if (!this.pendingTrial) return;
    const expected = this.pendingTrial.direction;
    if (expected === "change" && changeResult.edge === "change") {
      this.pendingTrial.ledAt = changeResult.edgeAt;
    } else if (expected === "rise" && cameraResult.edge === "rise") {
      this.pendingTrial.ledAt = cameraResult.edgeAt;
    } else if (expected === "fall" && cameraResult.edge === "fall") {
      this.pendingTrial.ledAt = cameraResult.edgeAt;
    }
    this.resolvePendingTrialIfReady();
  }

  handleAudioEvent(audioResult) {
    if (!this.pendingTrial || audioResult.edge !== "rise") return;
    this.pendingTrial.soundAt = audioResult.edgeAt;
    this.resolvePendingTrialIfReady();
  }

  resolvePendingTrialIfReady() {
    if (this.pendingTrial?.soundAt != null && this.pendingTrial.ledAt != null) {
      const trial = this.pendingTrial;
      this.pendingTrial = null;
      trial.resolve(trial);
    }
  }

  async prepareDarkReference() {
    await this.writeCommand(this.powerOffPacket, null);
    await wait(500);
    const samples = [];
    const sampleUntil = performance.now() + 400;
    while (performance.now() < sampleUntil) {
      if (this.latestLuma != null) samples.push(this.latestLuma);
      await wait(20);
    }
    this.darkReference = samples.length ? percentile(samples, 0.5) : 0;
    this.cameraDetector.edgeState = "dark";
    this.cameraDetector.signalState = "dark";
    this.onSensorStatus?.("Sensors ready");
  }

  async waitForDark() {
    const deadline = performance.now() + DARK_SETTLE_TIMEOUT_MS;
    let stableSince = null;
    while (performance.now() < deadline) {
      if (this.latestLuma != null && this.latestLuma <= this.darkReference + DARK_MARGIN) {
        stableSince ??= performance.now();
        if (performance.now() - stableSince >= 120) return true;
      } else {
        stableSince = null;
      }
      await wait(20);
    }
    return false;
  }

  async waitForBright() {
    const deadline = performance.now() + BRIGHT_SETTLE_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (this.latestLuma != null && this.latestLuma >= this.darkReference + BRIGHT_MARGIN) return true;
      await wait(20);
    }
    return false;
  }

  scheduleClick(targetAudioTime) {
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 1000;
    gain.gain.setValueAtTime(0.0001, targetAudioTime);
    gain.gain.exponentialRampToValueAtTime(0.35, targetAudioTime + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, targetAudioTime + 0.025);
    oscillator.connect(gain).connect(this.audioContext.destination);
    oscillator.start(targetAudioTime);
    oscillator.stop(targetAudioTime + 0.03);
  }

  async prepareProfile(definition) {
    if (definition.preparation === "dark") {
      await this.writeCommand(this.powerOffPacket, null);
      return this.waitForDark();
    }
    await this.writeCommand(this.litBaselinePacket, null);
    return this.waitForBright();
  }

  async runTrial(definition) {
    const prepared = await this.prepareProfile(definition);
    if (!prepared) {
      return { valid: false, reason: "baseline-timeout", profileId: definition.id };
    }

    this.cameraDetector.pending = null;
    this.cameraDetector.edgeState = definition.direction === "fall" ? "bright" : "dark";
    this.cameraDetector.signalState = this.cameraDetector.edgeState;
    this.changeDetector.arm(this.latestLuma);
    this.audioDetector.arm();

    const targetAudioTime = this.audioContext.currentTime + 0.7;
    const targetPerfTime = performance.now() + 700;
    this.scheduleClick(targetAudioTime);
    const trialPromise = new Promise((resolve) => {
      this.pendingTrial = {
        direction: definition.direction,
        soundAt: null,
        ledAt: null,
        resolve,
      };
    });
    const commandPromise = (async () => {
      const delay = targetPerfTime - performance.now();
      if (delay > 0) await wait(delay);
      const command = await this.writeCommand(definition.packet, definition.expectedResponse);
      return { ...command, commandStartAt: command.writeStart };
    })();

    const events = await Promise.race([trialPromise, wait(definition.timeoutMs).then(() => null)]);
    if (this.pendingTrial) this.pendingTrial = null;
    const command = await commandPromise;
    const trial = {
      profileId: definition.id,
      valid: Boolean(events?.soundAt != null && events?.ledAt != null && command.writeMs != null),
      reason: events ? null : "sensor-timeout",
      soundAt: events?.soundAt ?? null,
      ledAt: events?.ledAt ?? null,
      writeStart: command.writeStart ?? null,
      writeComplete: command.writeComplete ?? null,
      replyAt: command.replyAt ?? null,
      writeMs: command.writeMs ?? null,
      replyMs: command.replyMs ?? null,
      commandToLightMs: events?.ledAt != null && command.writeStart != null
        ? Math.max(0, events.ledAt - command.writeStart)
        : null,
      soundToLightMs: events?.soundAt != null && events.ledAt != null
        ? events.ledAt - events.soundAt
        : null,
      replyPacket: command.replyPacket || null,
    };
    await this.writeCommand(this.powerOffPacket, null);
    await this.waitForDark();
    return trial;
  }
}
