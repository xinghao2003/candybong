export const SHOW_FORMAT = "candybong-show";
export const SHOW_VERSION = 1;

export const CUE_MODES = Object.freeze([
  "off",
  "solid",
  "blink",
  "pulse",
  "slowPulse",
  "randomBlink",
  "hueSpin",
  "builtIn",
  "twiceShift",
]);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function integerInRange(value, minimum, maximum, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function createCueId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeCue(rawCue, duration = Infinity) {
  if (!rawCue || typeof rawCue !== "object" || Array.isArray(rawCue)) {
    throw new TypeError("Each cue must be an object");
  }

  const time = finiteNumber(rawCue.time, "Cue time");
  if (time < 0 || time > duration + 0.001) {
    throw new RangeError(`Cue time must be between 0 and ${Number.isFinite(duration) ? duration : "the track duration"}`);
  }

  const mode = String(rawCue.mode || "");
  if (!CUE_MODES.includes(mode)) throw new RangeError(`Unsupported cue mode: ${mode || "(empty)"}`);

  const color = String(rawCue.color || "#ff5fa2").toLowerCase();
  if (!HEX_COLOR.test(color)) throw new RangeError("Cue color must be a six-digit hex value");

  return {
    id: String(rawCue.id || createCueId()).slice(0, 80),
    time: Math.round(time * 1000) / 1000,
    mode,
    label: String(rawCue.label || "").trim().slice(0, 80),
    color,
    brightness: integerInRange(rawCue.brightness ?? 10, 0, 10, "Brightness"),
    speed: integerInRange(rawCue.speed ?? (mode === "hueSpin" ? 3 : 14), 0, mode === "hueSpin" ? 3 : 255, "Speed"),
    hue: integerInRange(rawCue.hue ?? 16, 0, 255, "Hue"),
    animationId: integerInRange(rawCue.animationId ?? 1, 1, 9, "Animation ID"),
    colorShift: integerInRange(rawCue.colorShift ?? 16, 1, 255, "Color shift"),
  };
}

export function sortCues(cues) {
  return [...cues].sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
}

export function normalizeShow(rawShow) {
  if (!rawShow || typeof rawShow !== "object" || Array.isArray(rawShow)) throw new TypeError("Show file must contain a JSON object");
  if (rawShow.format !== SHOW_FORMAT) throw new RangeError(`Unsupported show format: ${rawShow.format || "(missing)"}`);
  if (rawShow.version !== SHOW_VERSION) throw new RangeError(`Unsupported show version: ${rawShow.version}`);

  const track = rawShow.track && typeof rawShow.track === "object" ? rawShow.track : {};
  const duration = finiteNumber(track.duration, "Track duration");
  if (duration <= 0) throw new RangeError("Track duration must be greater than zero");

  const cueOffsetMs = integerInRange(rawShow.cueOffsetMs ?? 0, 0, 1000, "Cue offset");

  const cues = sortCues((Array.isArray(rawShow.cues) ? rawShow.cues : []).map((cue) => normalizeCue(cue, duration)));
  if (new Set(cues.map((cue) => cue.id)).size !== cues.length) throw new RangeError("Cue IDs must be unique");

  return {
    format: SHOW_FORMAT,
    version: SHOW_VERSION,
    cueOffsetMs,
    title: String(rawShow.title || track.filename || "Untitled show").trim().slice(0, 120),
    track: {
      filename: String(track.filename || "").slice(0, 255),
      type: String(track.type || "").slice(0, 100),
      size: Math.max(0, Math.trunc(finiteNumber(track.size ?? 0, "Track size"))),
      lastModified: Math.max(0, Math.trunc(finiteNumber(track.lastModified ?? 0, "Track last-modified time"))),
      duration: Math.round(duration * 1000) / 1000,
    },
    cues,
  };
}

export function createShow({ title, file, duration, cues, cueOffsetMs }) {
  return normalizeShow({
    format: SHOW_FORMAT,
    version: SHOW_VERSION,
    title: title || file?.name || "Untitled show",
    cueOffsetMs,
    track: {
      filename: file?.name || file?.filename || "",
      type: file?.type || "",
      size: file?.size || 0,
      lastModified: file?.lastModified || 0,
      duration,
    },
    cues,
  });
}

export function cueAtOrBefore(cues, time) {
  let active = null;
  for (const cue of sortCues(cues)) {
    if (cue.time > time + 0.001) break;
    active = cue;
  }
  return active;
}

export function cueModeLabel(mode) {
  return ({
    off: "Lights off",
    solid: "Solid color",
    blink: "Color blink",
    pulse: "Color pulse",
    slowPulse: "Slow color pulse",
    randomBlink: "Random-color blink",
    hueSpin: "Hue rotation",
    builtIn: "Built-in animation",
    twiceShift: "TWICE color shift",
  })[mode] || mode;
}

export function resolvePublishedAudioUrl(filename, showUrl, pageOrigin) {
  if (!filename) throw new Error("published show has no audio filename");
  const audioUrl = new URL(filename, showUrl);
  if (audioUrl.origin !== new URL(pageOrigin).origin) throw new Error("published audio must use the same web origin");
  return audioUrl.href;
}

export function formatTimestamp(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}
