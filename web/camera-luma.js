// Shared webcam engine for light-timing labs: extracts frame brightness from a
// camera stream and detects on/off edges of a bright light (the Candybong).
// Pure detection math is exported separately so it can run under node --test.

export function cameraSupportMessage() {
  if (!globalThis.isSecureContext) return "Camera access needs HTTPS or localhost.";
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) return "This browser does not expose camera input.";
  return "";
}

export function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "Camera permission was denied. Allow it in the browser site settings and try again.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No camera was found on this device.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "The camera is already in use or could not be opened.";
  }
  if (error?.name === "OverconstrainedError") {
    return "The camera does not support the requested mode. Try a different camera or device.";
  }
  return error?.message || "The camera could not be started.";
}

// Source rect for the analysis crop: side is roiFraction of the shorter edge;
// positionX/Y place the square's center as fractions of the visible frame
// (0.5 = center, matching the CSS alignment circle's position). The center is
// clamped so the square always stays inside the visible region — the region
// object-fit: cover shows in a square box. Returns null for degenerate
// dimensions; throws RangeError when roiFraction or a position is out of
// range.
export function captureSourceRect(videoWidth, videoHeight, roiFraction = 0.7, positionX = 0.5, positionY = 0.5) {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) {
    return null;
  }
  if (!Number.isFinite(roiFraction) || roiFraction <= 0 || roiFraction > 1) {
    throw new RangeError("roiFraction must be in (0, 1]");
  }
  if (
    !Number.isFinite(positionX) || !Number.isFinite(positionY) ||
    positionX < 0 || positionX > 1 || positionY < 0 || positionY > 1
  ) {
    throw new RangeError("position must be in [0, 1]");
  }
  const minDim = Math.min(videoWidth, videoHeight);
  const side = Math.max(1, Math.round(roiFraction * minDim));
  const half = side / 2;
  const visibleX = (videoWidth - minDim) / 2;
  const visibleY = (videoHeight - minDim) / 2;
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const centerX = clamp(visibleX + positionX * minDim, visibleX + half, visibleX + minDim - half);
  const centerY = clamp(visibleY + positionY * minDim, visibleY + half, visibleY + minDim - half);
  return {
    side,
    sx: Math.floor(centerX - half),
    sy: Math.floor(centerY - half),
  };
}

// Tracks whether the light in frame is on or off, using rolling percentile
// thresholds so it survives camera auto-exposure drift. A transition is only
// confirmed after the luma stays across the threshold for `confirmMs` (the
// caller adapts it to the measured frame interval), which filters sub-confirm
// flicker from lights and screens. Emits at most one edge per transition,
// timed at the moment the luma crossed. Returns `swing` (the rolling on/off
// range) and `lastEdgeAt` so callers can tell "blinking faster than the
// camera can see" apart from "nothing is changing".
export function createEdgeDetector(options = {}) {
  const windowFrames = options.windowFrames ?? 90;
  const solidTimeoutMs = options.solidTimeoutMs ?? 3000;
  const minSwing = options.minSwing ?? 10;

  const detector = {
    confirmMs: options.confirmMs ?? 50,
    history: [],
    signalState: "waiting",
    edgeState: "dark",
    pending: null,
    lastEdgeAt: null,

    step(luma, timeMs) {
      this.history.push(luma);
      if (this.history.length > windowFrames) this.history.shift();
      if (this.history.length < windowFrames) {
        return { luma, state: this.signalState, edge: null, edgeAt: null, swing: 0, lastEdgeAt: null };
      }

      const sorted = [...this.history].sort((a, b) => a - b);
      const low = sorted[Math.floor(sorted.length * 0.2)];
      const high = sorted[Math.floor(sorted.length * 0.8)];
      const swing = high - low;
      const threshold = (low + high) / 2;
      const margin = Math.max(swing * 0.15, 6);

      let edge = null;
      let edgeAt = null;
      if (swing < minSwing) {
        this.pending = null;
        this.signalState = "no-signal";
      } else {
        const current = luma > threshold + margin ? "bright" : luma < threshold - margin ? "dark" : null;
        if (current !== null && current !== this.edgeState) {
          if (!this.pending) this.pending = { direction: current === "bright" ? "rise" : "fall", crossedAt: timeMs };
        } else if (current === this.edgeState) {
          this.pending = null;
        }
        if (this.pending && timeMs - this.pending.crossedAt >= this.confirmMs) {
          edge = this.pending.direction;
          edgeAt = this.pending.crossedAt;
          this.edgeState = this.pending.direction === "rise" ? "bright" : "dark";
          this.lastEdgeAt = timeMs;
          this.signalState = this.edgeState;
          this.pending = null;
        }
      }

      if (!edge && this.lastEdgeAt !== null && timeMs - this.lastEdgeAt >= solidTimeoutMs) {
        this.signalState = "solid";
      }
      return { luma, state: this.signalState, edge, edgeAt, swing, lastEdgeAt: this.lastEdgeAt };
    },

    reset() {
      this.history = [];
      this.signalState = "waiting";
      this.edgeState = "dark";
      this.pending = null;
      this.lastEdgeAt = null;
    },
  };
  return detector;
}

// The tracker analyzes frames downsampled to a small canvas. It computes the
// mean luma (intuitive display) and the 99th percentile luma (the brightest
// part of the frame — the LED near clipping, which auto-exposure barely
// moves). The detector runs on one of them: "bright" (99th percentile) for
// on/off blink measurement, "mean" for brightness changes like the latency
// white flash. The confirm debounce follows the measured frame interval so
// fast blinks are still resolvable at the camera's actual frame rate.
//
// Analysis is restricted to a centered ROI square (roiFraction of the shorter
// edge, positionable like the alignment circle it matches) so background
// brightness outside the circle never feeds the detector; the labs' alignment
// guides drive it via setRoi/setPosition.
export class CameraLumaTracker {
  constructor({ onSample, onEnded, width = 64, height = 48, signal = "bright", roiFraction = 0.7, positionX = 0.5, positionY = 0.5 } = {}) {
    this.onSample = onSample;
    this.onEnded = onEnded;
    this.width = width;
    this.height = height;
    this.signal = signal;
    this.roiFraction = roiFraction;
    this.positionX = positionX;
    this.positionY = positionY;
    this.active = false;
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.context = null;
    this.histogram = null;
    this.animationFrame = null;
    this.startToken = 0;
    this.frameIntervalMs = 0;
    this.lastFrameAt = null;
    this.detector = createEdgeDetector();
    this.handleTrackEnded = this.handleTrackEnded.bind(this);
    this.sample = this.sample.bind(this);
  }

  async start(video) {
    if (this.active) return;
    const support = cameraSupportMessage();
    if (support) {
      const error = new Error(support);
      error.name = "NotSupportedError";
      throw error;
    }

    const startToken = ++this.startToken;
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", frameRate: { ideal: 60 } },
          audio: false,
        });
      } catch (error) {
        if (error?.name !== "OverconstrainedError") throw error;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      if (startToken !== this.startToken) {
        stream.getTracks().forEach((track) => track.stop());
        const error = new Error("Camera start was cancelled.");
        error.name = "AbortError";
        throw error;
      }
      this.stream = stream;
      this.video = video;
      if (video) {
        video.srcObject = stream;
        video.hidden = false;
        video.play().catch(() => {});
      }
      this.canvas = document.createElement("canvas");
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.context = this.canvas.getContext("2d", { willReadFrequently: true });
      this.histogram = new Uint32Array(256);
      this.frameIntervalMs = 0;
      this.lastFrameAt = null;
      this.detector.reset();
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", this.handleTrackEnded));
      this.active = true;
      this.animationFrame = requestAnimationFrame(this.sample);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    const video = this.video;
    this.startToken += 1;
    this.active = false;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;

    this.stream?.getVideoTracks().forEach((track) => {
      track.removeEventListener("ended", this.handleTrackEnded);
      track.stop();
    });
    if (video) {
      video.srcObject = null;
      video.hidden = true;
    }

    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.context = null;
    this.histogram = null;
  }

  handleTrackEnded() {
    if (!this.active) return;
    this.stop();
    this.onEnded?.();
  }

  // The analysis region: the source square captureSourceRect computes from
  // the current ROI fraction and circle position — the same geometry the
  // capture lab crops. Only the luma inside this region feeds the detector,
  // so background brightness outside the alignment circle is ignored.
  setRoi(fraction) {
    this.roiFraction = Math.max(0.01, Math.min(1, fraction));
  }

  setPosition(positionX, positionY) {
    this.positionX = positionX;
    this.positionY = positionY;
  }

  sample(now) {
    if (!this.active || !this.video || !this.context) return;
    const video = this.video;
    if (video.readyState < 2) {
      this.animationFrame = requestAnimationFrame(this.sample);
      return;
    }

    if (this.lastFrameAt !== null) {
      const elapsed = Math.min(250, Math.max(1, now - this.lastFrameAt));
      this.frameIntervalMs = this.frameIntervalMs === 0 ? elapsed : this.frameIntervalMs * 0.9 + elapsed * 0.1;
      this.detector.confirmMs = Math.max(2 * this.frameIntervalMs, 20);
    }
    this.lastFrameAt = now;

    const source = captureSourceRect(video.videoWidth, video.videoHeight, this.roiFraction, this.positionX, this.positionY);
    this.context.drawImage(video, source.sx, source.sy, source.side, source.side, 0, 0, this.width, this.height);
    const data = this.context.getImageData(0, 0, this.width, this.height).data;
    const histogram = this.histogram;
    histogram.fill(0);
    let sum = 0;
    for (let index = 0; index < data.length; index += 4) {
      const luma = (data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000;
      histogram[Math.min(255, Math.round(luma))] += 1;
      sum += luma;
    }
    const count = this.width * this.height;
    const mean = sum / count;
    const percentile = (fraction) => {
      const target = count * fraction;
      let cumulative = 0;
      for (let bin = 0; bin < 256; bin += 1) {
        cumulative += histogram[bin];
        if (cumulative >= target) return bin;
      }
      return 255;
    };
    const bright = percentile(0.99);
    const low = percentile(0.01);
    const input = this.signal === "mean" ? mean : bright;

    const result = this.detector.step(input, now);
    this.onSample?.({ ...result, signal: input, luma: mean, bright, timeMs: now });
    this.animationFrame = requestAnimationFrame(this.sample);
  }
}
