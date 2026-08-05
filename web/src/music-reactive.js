const MIN_FREQUENCY = 40;
const MAX_FREQUENCY = 8000;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function averageFrequencyBand(data, sampleRate, fftSize, minimum, maximum) {
  const binWidth = sampleRate / fftSize;
  const firstBin = clamp(Math.floor(minimum / binWidth), 0, data.length - 1);
  const lastBin = clamp(Math.ceil(maximum / binWidth), firstBin, data.length - 1);
  let total = 0;

  for (let index = firstBin; index <= lastBin; index += 1) total += data[index];
  return total / (lastBin - firstBin + 1) / 255;
}

function rootMeanSquare(data) {
  let total = 0;
  for (const sample of data) {
    const normalized = (sample - 128) / 128;
    total += normalized * normalized;
  }
  return Math.sqrt(total / data.length);
}

function quantizedHex(red, green, blue) {
  const channel = (value) => {
    const quantized = clamp(Math.round(value / 12) * 12, 0, 255);
    return Math.round(quantized).toString(16).padStart(2, "0");
  };
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function spectrumColor(low, mid, high, fallbackColor) {
  const strongest = Math.max(low, mid, high);
  if (strongest < 0.04) return fallbackColor;

  return quantizedHex(
    (low / strongest) * 255,
    (mid / strongest) * 255,
    (high / strongest) * 255,
  );
}

function microphoneSupport() {
  return Boolean(
    globalThis.isSecureContext
    && globalThis.navigator?.mediaDevices?.getUserMedia
    && (globalThis.AudioContext || globalThis.webkitAudioContext),
  );
}

export function microphoneSupportMessage() {
  if (!globalThis.isSecureContext) return "Microphone access needs HTTPS or localhost.";
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) return "This browser does not expose microphone input.";
  if (!(globalThis.AudioContext || globalThis.webkitAudioContext)) return "This browser does not support Web Audio.";
  return "";
}

export function microphoneErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "Microphone permission was denied. Allow it in the browser site settings and try again.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No microphone was found on this device.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "The microphone is already in use or could not be opened.";
  }
  return error?.message || "The microphone could not be started.";
}

export class MicrophoneReactiveController {
  constructor({ getSettings, onFrame, onEnded }) {
    this.getSettings = getSettings;
    this.onFrame = onFrame;
    this.onEnded = onEnded;
    this.active = false;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.analyser = null;
    this.animationFrame = null;
    this.startToken = 0;
    this.timeData = null;
    this.frequencyData = null;
    this.smoothedLevel = 0;
    this.smoothedBands = { low: 0, mid: 0, high: 0 };
    this.bassAverage = 0;
    this.previousBass = 0;
    this.beatStrength = 0;
    this.lastBeatAt = 0;
    this.lastFrameAt = 0;
    this.handleTrackEnded = this.handleTrackEnded.bind(this);
    this.sample = this.sample.bind(this);
  }

  async start() {
    if (this.active) return;
    if (!microphoneSupport()) {
      const error = new Error(microphoneSupportMessage());
      error.name = "NotSupportedError";
      throw error;
    }

    const startToken = ++this.startToken;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: 1,
        },
        video: false,
      });
      if (startToken !== this.startToken) {
        stream.getTracks().forEach((track) => track.stop());
        const error = new Error("Microphone start was cancelled.");
        error.name = "AbortError";
        throw error;
      }
      this.stream = stream;

      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.context = new AudioContextClass();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -20;
      this.analyser.smoothingTimeConstant = 0.68;
      this.source.connect(this.analyser);

      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
      this.smoothedLevel = 0;
      this.smoothedBands = { low: 0, mid: 0, high: 0 };
      this.bassAverage = 0;
      this.previousBass = 0;
      this.beatStrength = 0;
      this.lastBeatAt = 0;
      this.lastFrameAt = performance.now();

      this.stream.getAudioTracks().forEach((track) => track.addEventListener("ended", this.handleTrackEnded));
      if (this.context.state === "suspended") await this.context.resume();
      if (startToken !== this.startToken) {
        const error = new Error("Microphone start was cancelled.");
        error.name = "AbortError";
        throw error;
      }
      this.active = true;
      this.animationFrame = requestAnimationFrame(this.sample);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    const context = this.context;
    this.startToken += 1;
    this.active = false;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;

    this.stream?.getAudioTracks().forEach((track) => {
      track.removeEventListener("ended", this.handleTrackEnded);
      track.stop();
    });
    try { this.source?.disconnect(); } catch (error) { /* Already disconnected. */ }
    try { this.analyser?.disconnect(); } catch (error) { /* Already disconnected. */ }
    if (context && context.state !== "closed") context.close().catch(() => {});

    this.stream = null;
    this.context = null;
    this.source = null;
    this.analyser = null;
    this.timeData = null;
    this.frequencyData = null;
  }

  handleTrackEnded() {
    if (!this.active) return;
    this.stop();
    this.onEnded?.();
  }

  sample(now) {
    if (!this.active || !this.analyser || !this.context) return;

    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.frequencyData);

    const settings = this.getSettings();
    const sensitivity = clamp(Number(settings.sensitivity) || 5, 1, 10);
    const maximumBrightness = clamp(Number(settings.maximumBrightness) || 10, 1, 10);
    const elapsed = Math.min(100, Math.max(1, now - this.lastFrameAt));
    const rms = rootMeanSquare(this.timeData);
    const targetLevel = clamp((rms - 0.008) * (4.2 + sensitivity * 1.45));
    const levelRate = targetLevel > this.smoothedLevel ? 0.46 : 0.11;
    this.smoothedLevel += (targetLevel - this.smoothedLevel) * levelRate;

    const rawBands = {
      low: averageFrequencyBand(this.frequencyData, this.context.sampleRate, this.analyser.fftSize, MIN_FREQUENCY, 220),
      mid: averageFrequencyBand(this.frequencyData, this.context.sampleRate, this.analyser.fftSize, 220, 2000),
      high: averageFrequencyBand(this.frequencyData, this.context.sampleRate, this.analyser.fftSize, 2000, MAX_FREQUENCY),
    };
    for (const band of Object.keys(rawBands)) {
      const rate = rawBands[band] > this.smoothedBands[band] ? 0.42 : 0.13;
      this.smoothedBands[band] += (rawBands[band] - this.smoothedBands[band]) * rate;
    }

    if (this.bassAverage === 0) this.bassAverage = rawBands.low;
    this.bassAverage += (rawBands.low - this.bassAverage) * 0.035;
    const beatThreshold = Math.max(0.12, this.bassAverage * (1.68 - sensitivity * 0.047));
    const beat = rawBands.low > beatThreshold
      && rawBands.low > this.previousBass * 1.035
      && now - this.lastBeatAt > 230;
    if (beat) {
      this.beatStrength = 1;
      this.lastBeatAt = now;
    } else {
      this.beatStrength = Math.max(0, this.beatStrength - elapsed / 300);
    }
    this.previousBass = rawBands.low;
    this.lastFrameAt = now;

    let intensity = this.smoothedLevel;
    let color = settings.color;
    if (settings.mode === "beat") intensity = Math.max(0.08, this.beatStrength);
    if (settings.mode === "spectrum") {
      color = spectrumColor(
        this.smoothedBands.low,
        this.smoothedBands.mid,
        this.smoothedBands.high,
        settings.color,
      );
    }

    this.onFrame({
      bass: clamp(this.smoothedBands.low),
      beat,
      beatStrength: this.beatStrength,
      brightness: Math.max(1, Math.round(intensity * maximumBrightness)),
      color,
      level: this.smoothedLevel,
      timestamp: now,
    });

    this.animationFrame = requestAnimationFrame(this.sample);
  }
}
