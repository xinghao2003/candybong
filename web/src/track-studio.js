import {
  createCueId,
  createShow,
  cueAtOrBefore,
  cueModeLabel,
  formatTimestamp,
  normalizeCue,
  normalizeShow,
  resolvePublishedAudioUrl,
  sortCues,
} from "./show-format.js";

const WAVEFORM_BINS = 4000;
const SEEK_CUE_TOLERANCE_PX = 10;
const MIN_ZOOM_SPAN = 0.25;
const ZOOM_STEP = 1.6;
const ZOOM_WHEEL_STEP = 1.3;

function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFilename(value) {
  return String(value || "candybong-show")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "candybong-show";
}

export class TrackStudio {
  constructor({ root, onCue, onPlaybackChange, onNotice }) {
    if (!root) throw new Error("Track Studio root element is missing");
    this.root = root;
    this.onCue = onCue;
    this.onPlaybackChange = onPlaybackChange;
    this.onNotice = onNotice;
    this.file = null;
    this.expectedTrack = null;
    this.publishedAudioUrl = "";
    this.audioUrl = "";
    this.peaks = [];
    this.cues = [];
    this.selectedCueId = null;
    this.lastPlaybackTime = -0.01;
    this.animationFrame = 0;
    this.decodeGeneration = 0;
    this.zoomStart = 0;
    this.zoomEnd = 0;
    this.pointer = null;

    this.elements = Object.fromEntries([
      "trackFile", "showFile", "audio", "waveform", "trackName", "trackMeta", "time", "duration",
      "status", "cueTime", "cueMode", "cueLabel", "cueColor", "cueBrightness", "cueSpeed", "cueHue",
      "cueAnimationId", "cueColorShift", "addCue", "updateCue", "deleteCue", "cueList", "cueEmpty",
      "exportShow", "clearCues", "zoomIn", "zoomOut", "zoomReset", "zoomRange", "cueOffset",
    ].map((name) => [name, root.querySelector(`[data-studio="${name}"]`)]));

    this.context = this.elements.waveform.getContext("2d");
    this.cueOffsetMs = Math.max(0, Number(this.elements.cueOffset.value) || 0);
    this.bindEvents();
    this.updateCueFields();
    this.render();
    this.loadPublishedShowFromQuery();
  }

  bindEvents() {
    const elements = this.elements;
    elements.trackFile.addEventListener("change", (event) => this.loadTrack(event.target.files?.[0]));
    elements.showFile.addEventListener("change", (event) => this.loadShowFile(event.target.files?.[0]));
    elements.audio.addEventListener("loadedmetadata", () => this.handleMetadata());
    elements.audio.addEventListener("play", () => this.handlePlay());
    elements.audio.addEventListener("pause", () => this.handlePause());
    elements.audio.addEventListener("ended", () => this.handlePause());
    elements.audio.addEventListener("error", () => this.setStatus("The selected audio could not be played by this browser.", "error"));
    elements.audio.addEventListener("seeked", () => {
      // While a pointer drag is active the final state is dispatched once on pointerup.
      if (this.pointer) return;
      this.applyCueAt(elements.audio.currentTime, "seek");
    });
    elements.audio.addEventListener("timeupdate", () => this.renderTimeline());
    elements.waveform.addEventListener("pointerdown", (event) => this.handleTimelinePointer(event));
    // Move/up/cancel listen on window so a drag keeps working even without pointer capture.
    window.addEventListener("pointermove", (event) => this.handleTimelinePointerMove(event));
    window.addEventListener("pointerup", (event) => this.handleTimelinePointerUp(event));
    window.addEventListener("pointercancel", (event) => this.handleTimelinePointerCancel(event));
    elements.waveform.addEventListener("wheel", (event) => this.handleTimelineWheel(event), { passive: false });
    elements.waveform.addEventListener("contextmenu", (event) => event.preventDefault());
    elements.zoomIn.addEventListener("click", () => this.zoomBy(1 / ZOOM_STEP, this.elements.audio.currentTime));
    elements.zoomOut.addEventListener("click", () => this.zoomBy(ZOOM_STEP, this.elements.audio.currentTime));
    elements.zoomReset.addEventListener("click", () => this.resetZoom());
    elements.cueOffset.addEventListener("input", () => {
      this.cueOffsetMs = Math.max(0, Math.min(1000, Number(elements.cueOffset.value) || 0));
    });
    elements.cueMode.addEventListener("change", () => this.updateCueFields());
    elements.addCue.addEventListener("click", () => this.addCue());
    elements.updateCue.addEventListener("click", () => this.updateCue());
    elements.deleteCue.addEventListener("click", () => this.deleteCue());
    elements.exportShow.addEventListener("click", () => this.exportShow());
    elements.clearCues.addEventListener("click", () => this.clearCues());
    elements.cueList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cue-id]");
      if (button) this.selectCue(button.dataset.cueId, { seek: true });
    });
    window.addEventListener("resize", () => this.renderTimeline());
  }

  async loadTrack(file) {
    if (!file) return;
    if (!file.type.startsWith("audio/") && !/\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(file.name)) {
      this.notice("Choose a browser-playable audio file");
      return;
    }

    this.pauseForManualControl();
    this.file = file;
    this.publishedAudioUrl = "";
    this.peaks = [];
    this.zoomStart = 0;
    this.zoomEnd = 0;
    const generation = ++this.decodeGeneration;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = URL.createObjectURL(file);
    this.elements.audio.src = this.audioUrl;
    this.elements.trackName.textContent = file.name;
    this.elements.trackMeta.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · decoding waveform…`;
    this.setStatus("Loading track locally…", "loading");
    this.render();

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio decoding is unavailable");
      const audioContext = new AudioContextClass();
      const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
      await audioContext.close();
      if (generation !== this.decodeGeneration) return;
      this.peaks = this.extractPeaks(buffer);
      this.elements.trackMeta.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · ${formatTimestamp(buffer.duration)}`;
      const mismatchedName = this.expectedTrack?.filename && this.expectedTrack.filename !== file.name;
      this.setStatus(mismatchedName
        ? `Warning: show expects ${this.expectedTrack.filename}, but ${file.name} is loaded.`
        : "Track ready. Click the waveform to seek, then add a cue.", mismatchedName ? "warning" : null);
      this.render();
    } catch (error) {
      console.warn("Waveform decode failed", error);
      if (generation !== this.decodeGeneration) return;
      this.elements.trackMeta.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · waveform unavailable`;
      this.setStatus("Audio loaded; this format cannot be decoded for a waveform.", "warning");
      this.render();
    }
  }

  extractPeaks(buffer) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const binCount = Math.min(WAVEFORM_BINS, channels[0]?.length || 0);
    if (!binCount) return [];
    const blockSize = Math.max(1, Math.floor(channels[0].length / binCount));
    return Array.from({ length: binCount }, (_, bin) => {
      const start = bin * blockSize;
      const end = Math.min(channels[0].length, start + blockSize);
      let peak = 0;
      for (const channel of channels) {
        for (let sample = start; sample < end; sample += Math.max(1, Math.floor(blockSize / 64))) {
          peak = Math.max(peak, Math.abs(channel[sample]));
        }
      }
      return peak;
    });
  }

  handleMetadata() {
    const duration = this.duration();
    this.elements.duration.textContent = formatTimestamp(duration);
    this.elements.cueTime.max = String(duration || 0);
    if (this.file) this.elements.trackMeta.textContent = `${(this.file.size / 1024 / 1024).toFixed(1)} MB · ${formatTimestamp(duration)}`;
    if (this.expectedTrack && Math.abs(this.expectedTrack.duration - duration) > 0.25) {
      this.setStatus(`Warning: show expects ${formatTimestamp(this.expectedTrack.duration)}, but this track is ${formatTimestamp(duration)}.`, "warning");
    }
    this.render();
  }

  duration() {
    return Number.isFinite(this.elements.audio.duration) ? this.elements.audio.duration : (this.expectedTrack?.duration || 0);
  }

  setCueOffsetMs(value) {
    const offset = Math.max(0, Math.min(1000, Number(value) || 0));
    this.cueOffsetMs = offset;
    this.elements.cueOffset.value = String(offset);
  }

  // Zoom window in seconds. An empty window (zoomStart === zoomEnd) means the full track.
  viewStart() {
    return this.zoomEnd > this.zoomStart ? this.zoomStart : 0;
  }

  viewEnd() {
    return this.zoomEnd > this.zoomStart ? this.zoomEnd : this.duration();
  }

  isZoomed() {
    return this.zoomEnd > this.zoomStart;
  }

  timeToX(time, width) {
    return ((time - this.viewStart()) / (this.viewEnd() - this.viewStart())) * width;
  }

  xToTime(x, width) {
    return this.viewStart() + (x / width) * (this.viewEnd() - this.viewStart());
  }

  setZoomWindow(start, end) {
    const duration = this.duration();
    if (!duration) {
      this.zoomStart = 0;
      this.zoomEnd = 0;
      this.updateZoomControls();
      return;
    }
    const span = Math.max(MIN_ZOOM_SPAN, end - start);
    const maxStart = Math.max(0, duration - span);
    const clampedStart = Math.min(maxStart, Math.max(0, start));
    const clampedEnd = clampedStart + span;
    if (clampedStart <= 0.001 && clampedEnd >= duration - 0.001) {
      this.zoomStart = 0;
      this.zoomEnd = 0;
    } else {
      this.zoomStart = clampedStart;
      this.zoomEnd = clampedEnd;
    }
    this.renderTimeline();
    this.updateZoomControls();
  }

  zoomBy(factor, anchorTime) {
    if (!this.duration()) return;
    const start = this.viewStart();
    const end = this.viewEnd();
    const anchor = Math.min(end, Math.max(start, anchorTime));
    this.setZoomWindow(anchor - (anchor - start) * factor, anchor + (end - anchor) * factor);
  }

  resetZoom() {
    this.setZoomWindow(0, this.duration());
  }

  updateZoomControls() {
    const hasDuration = Boolean(this.duration());
    this.elements.zoomIn.disabled = !hasDuration;
    this.elements.zoomOut.disabled = !hasDuration;
    this.elements.zoomReset.disabled = !hasDuration || !this.isZoomed();
    this.elements.zoomRange.textContent = this.isZoomed()
      ? `${formatTimestamp(this.viewStart())} – ${formatTimestamp(this.viewEnd())}`
      : "Full track";
  }

  handlePlay() {
    // Start the lookback window before any cue whose effective (offset-shifted) time
    // is already in the past, e.g. a cue near 0 with a large offset.
    this.lastPlaybackTime = this.elements.audio.currentTime - 0.01 - this.cueOffsetMs / 1000;
    this.onPlaybackChange?.(true);
    this.setStatus("Playing show · keep this page in the foreground", "playing");
    this.tick();
  }

  handlePause() {
    window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.onPlaybackChange?.(false);
    if (this.file) this.setStatus("Paused");
    this.renderTimeline();
  }

  pauseForManualControl() {
    if (!this.elements.audio.paused) {
      this.elements.audio.pause();
      this.setStatus("Paused by manual lightstick control", "warning");
    }
  }

  tick() {
    if (this.elements.audio.paused || this.elements.audio.ended) return;
    const now = this.elements.audio.currentTime;
    if (!this.pointer && now + 0.02 < this.lastPlaybackTime) {
      this.applyCueAt(now, "seek");
    } else {
      // A cue fires when the playhead crosses its effective time (timestamp minus
      // the cue offset), so the command is sent early enough to match the music.
      const offset = this.cueOffsetMs / 1000;
      const due = this.cues.filter((cue) => {
        const effective = cue.time - offset;
        return effective > this.lastPlaybackTime + 0.001 && effective <= now + 0.025;
      });
      if (due.length) this.dispatchCue(due[due.length - 1], "playback");
    }
    this.lastPlaybackTime = now;
    // While zoomed, pan the window so the playhead stays visible during playback.
    if (this.isZoomed() && !this.pointer) {
      const span = this.zoomEnd - this.zoomStart;
      if (now < this.zoomStart || now > this.zoomEnd) {
        this.setZoomWindow(now - span * 0.12, now + span * 0.88);
      }
    }
    this.renderTimeline();
    this.animationFrame = window.requestAnimationFrame(() => this.tick());
  }

  applyCueAt(time, reason) {
    this.lastPlaybackTime = time;
    const cue = cueAtOrBefore(this.cues, time);
    if (cue) this.dispatchCue(cue, reason);
    // With a cue offset, a seek can land between a cue's effective time and its real
    // timestamp; the preview would otherwise skip that cue for the rest of the pass,
    // so re-fire the newest cue in that window.
    if (this.cueOffsetMs > 0) {
      const offset = this.cueOffsetMs / 1000;
      const overdue = this.cues.filter((item) => item.time > time + 0.001 && item.time - offset <= time);
      if (overdue.length) this.dispatchCue(overdue[overdue.length - 1], reason);
    }
  }

  dispatchCue(cue, reason) {
    // Highlight the active cue, but never rewrite the editor form: the form's cue time
    // tracks the playhead while scrubbing, and selection is reserved for explicit user clicks.
    this.selectedCueId = cue.id;
    this.render();
    Promise.resolve(this.onCue?.(cue, reason)).catch((error) => {
      console.error(error);
      this.setStatus(`Cue failed: ${error.message || "unknown error"}`, "error");
    });
  }

  handleTimelinePointer(event) {
    const duration = this.duration();
    if (!duration) return;
    const rect = this.elements.waveform.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));

    this.elements.waveform.style.cursor = event.button === 0 ? "ew-resize" : "grabbing";
    try {
      this.elements.waveform.setPointerCapture(event.pointerId);
    } catch (error) {
      // Capture is optional: the window-level move/up listeners keep the drag alive without it.
    }
    if (event.button !== 0) {
      // Right (or middle) drag pans the zoomed view instead of seeking.
      this.pointer = { mode: "pan", cueId: null, pointerId: event.pointerId, lastX: x };
      return;
    }
    const nearest = this.cues.reduce((match, cue) => {
      const cueX = this.timeToX(cue.time, rect.width);
      const distance = Math.abs(cueX - x);
      return distance < match.distance ? { cue, distance } : match;
    }, { cue: null, distance: Infinity });
    if (nearest.cue && nearest.distance <= SEEK_CUE_TOLERANCE_PX) {
      this.pointer = { mode: "move", cueId: nearest.cue.id, pointerId: event.pointerId };
      this.selectCue(nearest.cue.id, { seek: true });
    } else {
      this.pointer = { mode: "scrub", cueId: null, pointerId: event.pointerId };
      this.seekTo(this.xToTime(x, rect.width));
    }
  }

  handleTimelinePointerMove(event) {
    if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
    // A mouse release can be missed when it happens outside the window; without a
    // held button the gesture is over, so drop the stale drag state.
    if (event.pointerType === "mouse" && !event.buttons) {
      this.pointer = null;
      this.elements.waveform.style.cursor = "";
      return;
    }
    const duration = this.duration();
    if (!duration) return;
    const rect = this.elements.waveform.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    if (this.pointer.mode === "pan") {
      if (this.isZoomed()) {
        const span = this.viewEnd() - this.viewStart();
        const shift = ((x - this.pointer.lastX) / rect.width) * span;
        this.pointer.lastX = x;
        this.setZoomWindow(this.viewStart() - shift, this.viewEnd() - shift);
      }
      return;
    }
    const time = this.xToTime(x, rect.width);
    if (this.pointer.mode === "scrub") {
      this.seekTo(time);
      return;
    }
    const cue = this.cues.find((item) => item.id === this.pointer.cueId);
    if (!cue) return;
    cue.time = Math.round(Math.min(duration, Math.max(0, time)) * 1000) / 1000;
    this.cues = sortCues(this.cues);
    this.selectedCueId = cue.id;
    this.seekTo(cue.time);
    this.render();
  }

  handleTimelinePointerUp(event) {
    if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
    const wasPan = this.pointer.mode === "pan";
    this.pointer = null;
    this.elements.waveform.style.cursor = "";
    if (wasPan) return;
    // The drag is over: apply the active cue at the final position exactly once.
    this.applyCueAt(this.elements.audio.currentTime, "seek");
  }

  handleTimelinePointerCancel(event) {
    if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
    this.pointer = null;
    this.elements.waveform.style.cursor = "";
  }

  seekTo(time) {
    const duration = this.duration();
    const clamped = Math.min(duration, Math.max(0, time));
    this.elements.audio.currentTime = clamped;
    this.elements.cueTime.value = clamped.toFixed(3);
    this.renderTimeline();
  }

  // Plain wheel scroll zooms the timeline. Ctrl+wheel is reserved by the browser for
  // whole-page zoom, so it cannot be used for the waveform.
  handleTimelineWheel(event) {
    if (this.pointer || !this.duration()) return;
    event.preventDefault();
    const rect = this.elements.waveform.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    const factor = event.deltaY > 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP;
    this.zoomBy(factor, this.xToTime(x, rect.width));
  }

  cueFromForm(id = createCueId()) {
    return normalizeCue({
      id,
      time: this.elements.cueTime.value,
      mode: this.elements.cueMode.value,
      label: this.elements.cueLabel.value,
      color: this.elements.cueColor.value,
      brightness: this.elements.cueBrightness.value,
      speed: this.elements.cueSpeed.value,
      hue: this.elements.cueHue.value,
      animationId: this.elements.cueAnimationId.value,
      colorShift: this.elements.cueColorShift.value,
    }, this.duration() || Infinity);
  }

  addCue() {
    if (!this.duration()) {
      this.notice("Import a track before adding cues");
      this.elements.trackFile.focus();
      return;
    }
    try {
      const cue = this.cueFromForm();
      this.cues = sortCues([...this.cues, cue]);
      this.selectedCueId = cue.id;
      this.setStatus(`Added ${cueModeLabel(cue.mode)} at ${formatTimestamp(cue.time)}`);
      this.render();
    } catch (error) {
      this.notice(error.message);
    }
  }

  updateCue() {
    if (!this.selectedCueId) return;
    try {
      const cue = this.cueFromForm(this.selectedCueId);
      this.cues = sortCues(this.cues.map((item) => item.id === cue.id ? cue : item));
      this.setStatus(`Updated cue at ${formatTimestamp(cue.time)}`);
      this.render();
    } catch (error) {
      this.notice(error.message);
    }
  }

  deleteCue() {
    if (!this.selectedCueId) return;
    this.cues = this.cues.filter((cue) => cue.id !== this.selectedCueId);
    this.selectedCueId = null;
    this.setStatus("Cue deleted");
    this.render();
  }

  clearCues() {
    if (!this.cues.length) return;
    if (!window.confirm("Delete every cue from this show? Export first if you want a backup.")) return;
    this.cues = [];
    this.selectedCueId = null;
    this.setStatus("All cues cleared");
    this.render();
  }

  selectCue(id, { seek = false, focus = true } = {}) {
    const cue = this.cues.find((item) => item.id === id);
    if (!cue) return;
    this.selectedCueId = cue.id;
    this.elements.cueTime.value = cue.time.toFixed(3);
    this.elements.cueMode.value = cue.mode;
    this.elements.cueLabel.value = cue.label;
    this.elements.cueColor.value = cue.color;
    this.elements.cueBrightness.value = String(cue.brightness);
    this.elements.cueSpeed.value = String(cue.speed);
    this.elements.cueHue.value = String(cue.hue);
    this.elements.cueAnimationId.value = String(cue.animationId);
    this.elements.cueColorShift.value = String(cue.colorShift);
    if (seek && this.file) {
      this.elements.audio.currentTime = cue.time;
      // Bring the cue into view when it sits outside the zoomed window (e.g. a cue-list click).
      if (this.isZoomed() && (cue.time < this.viewStart() || cue.time > this.viewEnd())) {
        const span = this.zoomEnd - this.zoomStart;
        this.setZoomWindow(cue.time - span * 0.15, cue.time + span * 0.85);
      }
    }
    if (focus) this.elements.cueMode.focus({ preventScroll: true });
    this.updateCueFields();
    this.renderCueList();
    this.renderTimeline();
  }

  updateCueFields() {
    const mode = this.elements.cueMode.value;
    this.root.querySelectorAll("[data-cue-field]").forEach((field) => {
      field.hidden = !field.dataset.cueField.split(" ").includes(mode);
    });
    this.elements.cueSpeed.max = mode === "hueSpin" ? "3" : "255";
    if (mode === "hueSpin" && Number(this.elements.cueSpeed.value) > 3) this.elements.cueSpeed.value = "3";
    const selected = Boolean(this.selectedCueId);
    this.elements.updateCue.disabled = !selected;
    this.elements.deleteCue.disabled = !selected;
  }

  async loadShowFile(file) {
    if (!file) return;
    try {
      const show = normalizeShow(JSON.parse(await file.text()));
      this.publishedAudioUrl = "";
      if (!this.file) {
        this.elements.audio.removeAttribute("src");
        this.elements.audio.load();
      }
      this.applyShow(show, file.name);
    } catch (error) {
      this.notice(`Could not load show: ${error.message}`);
    } finally {
      this.elements.showFile.value = "";
    }
  }

  applyShow(show, sourceLabel) {
    this.cues = show.cues;
    this.expectedTrack = show.track;
    this.selectedCueId = null;
    this.zoomStart = 0;
    this.zoomEnd = 0;
    this.cueOffsetMs = show.cueOffsetMs;
    this.elements.cueOffset.value = String(show.cueOffsetMs);
    this.elements.cueTime.max = String(show.track.duration);
    this.elements.trackName.textContent = this.file?.name || show.track.filename || "Track not loaded";
    this.elements.trackMeta.textContent = this.file
      ? `${(this.file.size / 1024 / 1024).toFixed(1)} MB · ${formatTimestamp(this.duration())}`
      : `Show loaded · ${formatTimestamp(show.track.duration)} · ${show.cues.length} cues`;
    const mismatch = this.file && show.track.filename && this.file.name !== show.track.filename;
    this.setStatus(mismatch
      ? `Show expects ${show.track.filename}; currently loaded audio is ${this.file.name}.`
      : `Loaded ${show.cues.length} cues from ${sourceLabel}`, mismatch ? "warning" : null);
    this.render();
  }

  async loadPublishedShowFromQuery() {
    const showUrl = new URLSearchParams(window.location.search).get("show");
    if (!showUrl) return;
    try {
      this.setStatus("Loading published show…", "loading");
      const resolvedShowUrl = new URL(showUrl, window.location.href);
      if (resolvedShowUrl.origin !== window.location.origin) throw new Error("published show must use the same web origin");
      const response = await fetch(resolvedShowUrl, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`show request returned HTTP ${response.status}`);
      const show = normalizeShow(await response.json());
      this.applyShow(show, showUrl);
      this.publishedAudioUrl = resolvePublishedAudioUrl(show.track.filename, response.url, window.location.origin);
      this.elements.audio.src = this.publishedAudioUrl;
      this.elements.trackName.textContent = show.title;
      this.elements.trackMeta.textContent = `${show.track.filename} · ${show.cues.length} cues`;
      this.setStatus("Published show ready. Press play to preview or control a connected Candybong.");
      this.render();
    } catch (error) {
      console.error("Published show load failed", error);
      this.setStatus(`Could not load published show: ${error.message}`, "error");
    }
  }

  exportShow() {
    const duration = this.duration();
    if (!duration) {
      this.notice("Import the show track before exporting");
      return;
    }
    try {
      const show = createShow({
        title: this.file?.name || this.expectedTrack?.filename || "Candybong show",
        file: this.file || this.expectedTrack,
        duration,
        cues: this.cues,
        cueOffsetMs: this.cueOffsetMs,
      });
      downloadJson(`${safeFilename(show.title)}.candybong.json`, show);
      this.setStatus(`Exported ${show.cues.length} cues. The audio file is not embedded.`);
    } catch (error) {
      this.notice(error.message);
    }
  }

  notice(message) {
    this.onNotice?.(message);
    this.setStatus(message, "error");
  }

  setStatus(message, style = null) {
    this.elements.status.textContent = message;
    this.elements.status.classList.remove("loading", "playing", "warning", "error");
    if (style) this.elements.status.classList.add(style);
  }

  render() {
    const hasDuration = Boolean(this.duration());
    this.elements.audio.hidden = !this.file && !this.publishedAudioUrl;
    this.elements.exportShow.disabled = !hasDuration;
    this.elements.clearCues.disabled = !this.cues.length;
    this.elements.addCue.disabled = !hasDuration;
    this.elements.time.textContent = formatTimestamp(this.elements.audio.currentTime);
    this.elements.duration.textContent = formatTimestamp(this.duration());
    this.renderCueList();
    this.updateCueFields();
    this.updateZoomControls();
    this.renderTimeline();
  }

  renderCueList() {
    this.elements.cueList.replaceChildren();
    this.elements.cueEmpty.hidden = Boolean(this.cues.length);
    for (const cue of this.cues) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.cueId = cue.id;
      button.className = "studio-cue-button";
      button.classList.toggle("active", cue.id === this.selectedCueId);
      const marker = document.createElement("span");
      marker.className = "studio-cue-color";
      marker.style.background = cue.mode === "off" ? "#393339" : cue.color;
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = cue.label || cueModeLabel(cue.mode);
      const detail = document.createElement("small");
      detail.textContent = `${formatTimestamp(cue.time)} · ${cueModeLabel(cue.mode)}`;
      copy.append(title, detail);
      button.append(marker, copy);
      item.append(button);
      this.elements.cueList.append(item);
    }
  }

  renderTimeline() {
    const canvas = this.elements.waveform;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = "#f5f1f4";
    context.fillRect(0, 0, rect.width, rect.height);

    const duration = this.duration();
    const viewStart = this.viewStart();
    const viewEnd = this.viewEnd();
    const viewSpan = viewEnd - viewStart;
    if (!duration || !viewSpan) return;
    const timeToX = (time) => ((time - viewStart) / viewSpan) * rect.width;

    const center = rect.height / 2;
    context.fillStyle = "#d9cfd6";
    if (this.peaks.length) {
      const binDuration = duration / this.peaks.length;
      this.peaks.forEach((peak, index) => {
        const binStart = index * binDuration;
        const binEnd = binStart + binDuration;
        if (binEnd < viewStart || binStart > viewEnd) return;
        const barHeight = Math.max(1, peak * (rect.height - 24));
        const barLeft = timeToX(binStart);
        context.fillRect(barLeft, center - barHeight / 2, Math.max(1, timeToX(binEnd) - barLeft), barHeight);
      });
    } else {
      context.fillRect(0, center - 1, rect.width, 2);
    }

    for (const cue of this.cues) {
      const x = timeToX(cue.time);
      if (x < -2 || x > rect.width + 2) continue;
      context.strokeStyle = cue.id === this.selectedCueId ? "#7d2450" : cue.mode === "off" ? "#393339" : cue.color;
      context.lineWidth = cue.id === this.selectedCueId ? 3 : 2;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, rect.height);
      context.stroke();
      context.fillStyle = context.strokeStyle;
      context.beginPath();
      context.moveTo(x - 5, 0);
      context.lineTo(x + 5, 0);
      context.lineTo(x, 7);
      context.closePath();
      context.fill();
    }

    const playheadTime = this.elements.audio.currentTime;
    const playhead = Math.min(rect.width, Math.max(0, timeToX(playheadTime)));
    context.globalAlpha = playheadTime < viewStart || playheadTime > viewEnd ? 0.35 : 1;
    context.strokeStyle = "#ef4f91";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(playhead, 0);
    context.lineTo(playhead, rect.height);
    context.stroke();
    context.globalAlpha = 1;
    this.elements.time.textContent = formatTimestamp(playheadTime);
  }
}
