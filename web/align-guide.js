// Shared alignment overlay for the camera labs and the capture lab: a dimmed
// surround with a center guide circle, rendered in pure CSS (no per-frame
// drawing), whose size and position are adjustable by gesture — drag to
// move, pinch (or Ctrl+scroll on desktop, which trackpads deliver as
// Ctrl+wheel) to resize. The guide creates its own dimmer, ring, and hint
// elements inside the frame. The frame must stay square (aspect-ratio 1/1):
// with object-fit: cover the visible native region is the centered square of
// side min(videoWidth, videoHeight), so the circle's bounding box (ROI × box
// side) maps exactly onto the analysis crop (ROI × min edge) computed by
// captureSourceRect in camera-luma.js. A non-square box silently shrinks the
// circle below the crop. Change notifications let consumers (e.g. a luma
// tracker) follow the circle.

export class AlignmentGuide {
  constructor({
    frame,
    hint = "Drag to move · pinch to resize",
    roiFraction = 0.7,
    roiMin = 0.4,
    roiMax = 0.9,
    onRoiChange = null,
    onPositionChange = null,
  } = {}) {
    if (!frame) throw new Error("Alignment guide frame is missing");
    this.frame = frame;
    this.onRoiChange = onRoiChange;
    this.onPositionChange = onPositionChange;
    this.defaultRoi = roiFraction;
    this.roiMin = roiMin;
    this.roiMax = roiMax;
    this.roiFraction = roiFraction;
    this.positionX = 0.5;
    this.positionY = 0.5;

    this.dimmer = document.createElement("div");
    this.dimmer.className = "align-guide-dimmer";
    this.dimmer.setAttribute("aria-hidden", "true");
    this.ring = document.createElement("div");
    this.ring.className = "align-guide-ring";
    this.ring.setAttribute("aria-hidden", "true");
    this.hint = document.createElement("span");
    this.hint.className = "align-guide-hint";
    this.hint.textContent = hint;
    frame.append(this.dimmer, this.ring, this.hint);

    this.applyRoi();
    this.applyPosition();
    this.setVisible(false);
    this.bindDrag();
  }

  setVisible(on) {
    this.dimmer.hidden = !on;
    this.ring.hidden = !on;
    this.hint.hidden = !on;
  }

  // One control for both axes: back to the default size and centered.
  reset() {
    this.setRoi(this.defaultRoi);
    this.setPosition(0.5, 0.5);
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
    this.onPositionChange?.(this.positionX, this.positionY);
  }

  // Clamps to the configured range and re-clamps the position (a bigger
  // circle may not fit at the current spot).
  setRoi(fraction) {
    this.roiFraction = Math.min(this.roiMax, Math.max(this.roiMin, fraction));
    this.applyRoi();
    this.onRoiChange?.(this.roiFraction);
    this.setPosition(this.positionX, this.positionY);
  }

  applyRoi() {
    this.frame.style.setProperty("--roi", this.roiFraction.toFixed(2));
  }

  applyPosition() {
    this.frame.style.setProperty("--pos-x", `${(this.positionX * 100).toFixed(1)}%`);
    this.frame.style.setProperty("--pos-y", `${(this.positionY * 100).toFixed(1)}%`);
  }

  // Frame gestures: drag (one finger / mouse) moves the circle, pinch (two
  // fingers) resizes it, and Ctrl+scroll also resizes (trackpad pinch
  // arrives as Ctrl+wheel, so laptops get it too). The overlay elements stay
  // pointer-events: none, so hits pass through to the frame. Cleanup runs on
  // every release path: pointerup, pointercancel, and lostpointercapture
  // (which fires whenever capture ends, even if up/cancel never reached us),
  // plus a buttons === 0 guard so a stale drag can never let mouse hover
  // drive the circle.
  bindDrag() {
    const frame = this.frame;

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
}
