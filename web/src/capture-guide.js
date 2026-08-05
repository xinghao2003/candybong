// Guided camera capture for the Capture Lab: shows a live preview with an
// alignment circle and dimmed surround (see align-guide.js), then captures
// the circle's bounding square from the frame, applies a circular mask, and
// resizes it to CAPTURE_SIZE (224×224) for detection. The crop is computed
// with captureSourceRect (camera-luma.js) from the guide's ROI fraction and
// circle position, so exactly what the user sees inside the circle is what
// gets captured. A single Reset button restores the default size and center.
// The getUserMedia open below intentionally mirrors camera-luma.js:141-150
// so constraint changes stay applied in both places. Pure crop math is
// exported from camera-luma.js so it can run in Vitest without a camera.

import { captureSourceRect, cameraErrorMessage, cameraSupportMessage } from "./camera-luma.js";
import { AlignmentGuide } from "./align-guide.js";

export const CAPTURE_SIZE = 224;

const ELEMENT_NAMES = [
  "status",
  "startCamera",
  "stopCamera",
  "frame",
  "preview",
  "captureButton",
  "reset",
  "resultCanvas",
  "resultText",
];

export class CaptureGuide {
  constructor({ root, roiFraction = 0.7, onCapture = null, onDiagnostic = null, onToast = null }) {
    if (!root) throw new Error("Capture Lab root element is missing");
    this.root = root;
    this.onCapture = onCapture;
    this.onDiagnostic = onDiagnostic;
    this.onToast = onToast;

    this.elements = Object.fromEntries(ELEMENT_NAMES.map((name) => [name, root.querySelector(`[data-capture="${name}"]`)]));
    this.cameraOn = false;
    this.startToken = 0;
    this.stream = null;
    this.video = null;
    this.handleTrackEnded = this.handleTrackEnded.bind(this);

    this.guide = new AlignmentGuide({
      frame: this.elements.frame,
      hint: "Drag to move · pinch to resize",
      roiFraction,
    });

    // Offscreen canvas the capture pipeline draws into; never appended to the DOM.
    this.outputCanvas = document.createElement("canvas");
    this.outputCanvas.width = CAPTURE_SIZE;
    this.outputCanvas.height = CAPTURE_SIZE;

    this.bindEvents();
    this.setStatus("Camera off", null);
    this.render();
  }

  bindEvents() {
    const elements = this.elements;
    elements.startCamera.addEventListener("click", () => this.startCamera());
    elements.stopCamera.addEventListener("click", () => this.stopCamera());
    elements.captureButton.addEventListener("click", () => this.handleCapture());
    elements.reset.addEventListener("click", () => this.guide.reset());
  }

  setStatus(message, style = null) {
    this.elements.status.textContent = message;
    this.elements.status.classList.remove("listening", "warning");
    if (style) this.elements.status.classList.add(style);
  }

  render() {
    const cameraOn = this.cameraOn;
    this.elements.startCamera.disabled = cameraOn;
    this.elements.stopCamera.disabled = !cameraOn;
    this.elements.captureButton.disabled = !cameraOn;
  }

  // Camera open mirroring camera-luma.js:141-150, minus the luma analysis
  // loop that this capture-only panel does not need. Same support gate and
  // OverconstrainedError fallback so errors stay consistent across panels.
  async openCameraStream() {
    const support = cameraSupportMessage();
    if (support) {
      const error = new Error(support);
      error.name = "NotSupportedError";
      throw error;
    }
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
    return stream;
  }

  async startCamera() {
    if (this.cameraOn) return;
    const startToken = ++this.startToken;
    try {
      const stream = await this.openCameraStream();
      if (startToken !== this.startToken) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.video = this.elements.preview;
      this.video.srcObject = stream;
      this.video.hidden = false;
      this.guide.setVisible(true);
      this.video.play().catch(() => {});
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", this.handleTrackEnded));
      this.cameraOn = true;
      this.setStatus("Camera on · align the head in the circle", "listening");
      this.onDiagnostic?.("SYS", "Capture Lab camera started", null, "status");
    } catch (error) {
      const message = cameraErrorMessage(error);
      this.setStatus(message, "warning");
      this.onToast?.(message);
    }
    this.render();
  }

  stopCamera(message = null) {
    const wasOn = this.cameraOn;
    this.startToken += 1;
    this.cameraOn = false;
    this.stream?.getVideoTracks().forEach((track) => {
      track.removeEventListener("ended", this.handleTrackEnded);
      track.stop();
    });
    this.stream = null;
    this.video = null;
    if (this.elements.preview) {
      this.elements.preview.srcObject = null;
      this.elements.preview.hidden = true;
    }
    this.guide.setVisible(false);
    this.setStatus("Camera off", null);
    this.render();
    if (wasOn && message) {
      this.onToast?.(message);
      this.onDiagnostic?.("SYS", message, null, "status");
    }
  }

  handleTrackEnded() {
    if (!this.cameraOn) return;
    this.stopCamera("Camera input ended");
  }

  async handleCapture() {
    try {
      await this.capture();
    } catch (error) {
      this.setStatus(error.message || "Capture failed", "warning");
    }
  }

  // Crop the circle's bounding square (same geometry as the guide circle),
  // resize it to CAPTURE_SIZE in one drawImage pass, mask it to a circle,
  // then return ImageData plus a PNG blob. The mask is applied after the
  // resize: an alpha multiply commutes with the bilinear downscale, and
  // masking at 224 avoids a second full-resolution canvas.
  async capture() {
    const video = this.video;
    if (!this.cameraOn || !video) throw new Error("Camera is off");
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      throw new Error("Camera frame is not ready yet");
    }
    const source = captureSourceRect(
      video.videoWidth,
      video.videoHeight,
      this.guide.roiFraction,
      this.guide.positionX,
      this.guide.positionY,
    );
    const context = this.outputCanvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
    context.drawImage(video, source.sx, source.sy, source.side, source.side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
    context.save();
    context.globalCompositeOperation = "destination-in";
    context.beginPath();
    context.arc(CAPTURE_SIZE / 2, CAPTURE_SIZE / 2, CAPTURE_SIZE / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    const imageData = context.getImageData(0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
    const blob = await new Promise((resolve, reject) => {
      this.outputCanvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("Could not encode the capture as PNG"))),
        "image/png",
      );
    });
    const result = {
      imageData,
      blob,
      width: CAPTURE_SIZE,
      height: CAPTURE_SIZE,
      roiFraction: this.guide.roiFraction,
      positionX: this.guide.positionX,
      positionY: this.guide.positionY,
      source,
    };
    this.onCapture?.(result);
    this.renderResult(result);
    return result;
  }

  renderResult(result) {
    this.elements.resultCanvas.getContext("2d").putImageData(result.imageData, 0, 0);
    this.elements.resultCanvas.hidden = false;
    this.elements.resultText.textContent =
      `Captured ${result.source.side}×${result.source.side} → ${result.width}×${result.height} · PNG ` +
      `${Math.max(1, Math.round(result.blob.size / 1024))} KB`;
  }
}
