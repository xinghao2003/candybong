// Guided camera capture for the Capture Lab: shows a live preview with a
// center guide circle and a dimmed surround, then captures a fixed centered
// square from the frame, applies a circular mask, and resizes it to
// CAPTURE_SIZE (224×224) for detection. The overlay is pure CSS — no
// per-frame drawing — and depends on the preview box staying square
// (aspect-ratio 1/1): with object-fit: cover the visible native region is the
// centered square of side min(videoWidth, videoHeight), so the circle's
// bounding box (ROI × box side) maps exactly onto the captured crop
// (ROI × min edge) for any camera aspect ratio. The circle starts centered
// at the default size and is adjusted purely by gesture — drag to move,
// pinch or Ctrl+scroll to resize — with a single Reset button restoring the
// default size and center. The getUserMedia
// open below intentionally mirrors camera-luma.js:141-150 so constraint
// changes stay applied in both places. Pure crop math is exported separately
// so it can run under node --test.

import { cameraErrorMessage, cameraSupportMessage } from "./camera-luma.js";

export const CAPTURE_SIZE = 224;
const DEFAULT_ROI = 0.7;
const ROI_MIN = 0.4;
const ROI_MAX = 0.9;

// Source rect for the crop square: side is roiFraction of the shorter edge;
// positionX/Y place the square's center as fractions of the visible frame
// (0.5 = center, matching the CSS circle's position). The center is clamped
// so the square always stays inside the visible region — the region
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

const ELEMENT_NAMES = [
  "status",
  "startCamera",
  "stopCamera",
  "frame",
  "preview",
  "overlay",
  "captureButton",
  "reset",
  "resultCanvas",
  "resultText",
];

export class CaptureGuide {
  constructor({ root, roiFraction = DEFAULT_ROI, onCapture = null, onDiagnostic = null, onToast = null }) {
    if (!root) throw new Error("Capture Lab root element is missing");
    this.root = root;
    this.onCapture = onCapture;
    this.onDiagnostic = onDiagnostic;
    this.onToast = onToast;

    this.elements = Object.fromEntries(ELEMENT_NAMES.map((name) => [name, root.querySelector(`[data-capture="${name}"]`)]));
    this.cameraOn = false;
    this.roiFraction = roiFraction;
    this.positionX = 0.5;
    this.positionY = 0.5;
    this.startToken = 0;
    this.stream = null;
    this.video = null;
    this.handleTrackEnded = this.handleTrackEnded.bind(this);

    // Offscreen canvas the capture pipeline draws into; never appended to the DOM.
    this.outputCanvas = document.createElement("canvas");
    this.outputCanvas.width = CAPTURE_SIZE;
    this.outputCanvas.height = CAPTURE_SIZE;

    this.elements.frame.style.setProperty("--roi", this.roiFraction.toFixed(2));
    this.applyPosition();
    this.bindEvents();
    this.bindDrag();
    this.setStatus("Camera off", null);
    this.render();
  }

  bindEvents() {
    const elements = this.elements;
    elements.startCamera.addEventListener("click", () => this.startCamera());
    elements.stopCamera.addEventListener("click", () => this.stopCamera());
    elements.captureButton.addEventListener("click", () => this.handleCapture());
    elements.reset.addEventListener("click", () => this.reset());
  }

  // Frame gestures for the circle, always active: drag (one finger / mouse)
  // moves it, pinch (two fingers) resizes it, and Ctrl+scroll also resizes
  // (trackpad pinch arrives as Ctrl+wheel, so laptops get it too). Handlers
  // sit on the frame (the stable target) and the overlay stays
  // pointer-events: none, so hits pass through it to the frame. Cleanup runs
  // on every release path: pointerup, pointercancel, and lostpointercapture
  // (which fires whenever capture ends, even if up/cancel never reached us),
  // plus a buttons === 0 guard so a stale drag can never let mouse hover
  // drive the circle.
  bindDrag() {
    const frame = this.elements.frame;

    let dragging = false;
    let pinching = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startPosX = 0;
    let startPosY = 0;
    let pinchStartDistance = 0;
    let pinchStartRoi = 0;
    const pointers = new Map(); // pointerId → current {x, y}

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      frame.classList.remove("dragging");
      if (pointerId !== null) {
        try {
          frame.releasePointerCapture(pointerId);
        } catch {
          // Already released or never captured.
        }
        pointerId = null;
      }
    };

    const removePointer = (event) => {
      pointers.delete(event.pointerId);
      if (event.pointerId === pointerId) endDrag();
      if (pinching && pointers.size < 2) {
        pinching = false;
        endDrag();
      }
    };

    frame.addEventListener("pointerdown", (event) => {
      if (pointers.size >= 2) return;
      event.preventDefault(); // no text selection / image drag / callout
      if (pointers.size === 0) {
        // First finger: position drag.
        dragging = true;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startPosX = this.positionX;
        startPosY = this.positionY;
        frame.classList.add("dragging");
        try {
          frame.setPointerCapture(event.pointerId);
        } catch {
          // Capture is optional; the frame itself is a large fallback target.
        }
      } else if (pointers.size === 1 && !pinching) {
        // Second finger: pinch to resize. Suspend the position drag so the
        // two gestures never fight.
        dragging = false;
        pinching = true;
        pinchStartRoi = this.roiFraction;
        try {
          frame.setPointerCapture(event.pointerId);
        } catch {
          // Capture is optional; pointer events still bubble from the video.
        }
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinching && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStartDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      }
    });

    frame.addEventListener("pointermove", (event) => {
      const pointer = pointers.get(event.pointerId);
      if (pointer) {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
      }
      if (pinching && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        this.setRoi(pinchStartRoi * (distance / pinchStartDistance));
        return;
      }
      if (!dragging || event.pointerId !== pointerId) return;
      if (event.buttons === 0) {
        endDrag(); // mouse button lifted outside any pointerup we saw
        return;
      }
      const rect = frame.getBoundingClientRect();
      this.setPosition(
        startPosX + (event.clientX - startX) / rect.width,
        startPosY + (event.clientY - startY) / rect.height,
      );
    });

    frame.addEventListener("pointerup", removePointer);
    frame.addEventListener("pointercancel", removePointer);
    frame.addEventListener("lostpointercapture", removePointer);

    // Ctrl+scroll resizes the circle. Trackpad pinch arrives as Ctrl+wheel,
    // so this covers laptop pinch gestures too; preventDefault stops the
    // browser's own page zoom.
    frame.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        this.setRoi(this.roiFraction + (event.deltaY < 0 ? 0.05 : -0.05));
      },
      { passive: false },
    );
  }

  // The crop is the circle's bounding square, so the circle's half-extent is
  // roiFraction/2 of the frame in both CSS and native terms; clamping the
  // position to [roi/2, 1 − roi/2] keeps the whole circle (and the crop it
  // bounds) inside the frame.
  setPosition(positionX, positionY) {
    const half = this.roiFraction / 2;
    this.positionX = Math.min(1 - half, Math.max(half, positionX));
    this.positionY = Math.min(1 - half, Math.max(half, positionY));
    this.applyPosition();
  }

  applyPosition() {
    this.elements.frame.style.setProperty("--pos-x", `${(this.positionX * 100).toFixed(1)}%`);
    this.elements.frame.style.setProperty("--pos-y", `${(this.positionY * 100).toFixed(1)}%`);
  }

  setStatus(message, style = null) {
    this.elements.status.textContent = message;
    this.elements.status.classList.remove("listening", "warning");
    if (style) this.elements.status.classList.add(style);
  }

  // Shared resize path for pinch and Ctrl+scroll: clamps to the ROI range and
  // re-clamps the circle position (a bigger circle may not fit at the spot).
  setRoi(fraction) {
    this.roiFraction = Math.min(ROI_MAX, Math.max(ROI_MIN, fraction));
    this.elements.frame.style.setProperty("--roi", this.roiFraction.toFixed(2));
    this.setPosition(this.positionX, this.positionY);
  }

  // One control for both axes: back to the default size and centered.
  reset() {
    this.setRoi(DEFAULT_ROI);
    this.setPosition(0.5, 0.5);
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
      this.elements.overlay.hidden = false;
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
    this.elements.overlay.hidden = true;
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

  // Crop the centered square ROI (the guide circle's bounding box), resize it
  // to CAPTURE_SIZE in one drawImage pass, mask it to a circle, then return
  // ImageData plus a PNG blob. The mask is applied after the resize: an alpha
  // multiply commutes with the bilinear downscale, and masking at 224 avoids
  // a second full-resolution canvas.
  async capture() {
    const video = this.video;
    if (!this.cameraOn || !video) throw new Error("Camera is off");
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      throw new Error("Camera frame is not ready yet");
    }
    const source = captureSourceRect(video.videoWidth, video.videoHeight, this.roiFraction, this.positionX, this.positionY);
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
      roiFraction: this.roiFraction,
      positionX: this.positionX,
      positionY: this.positionY,
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
