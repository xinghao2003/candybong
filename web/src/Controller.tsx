import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  LIGHTSTICK_ADAPTERS,
  blinkSpeedForRate,
  randomBlinkSpeedForRate,
} from "./adapters.js";
import { useBluetoothSession } from "./bluetooth-session";
import { previewBackgroundFromHex, previewColorFromHex } from "./color-preview.js";
import type { AnimationParameters, ControllerState, LightstickAdapter } from "./domain";
import { packetLabel } from "./domain";

type CommandMode =
  | "blink"
  | "fadeFast"
  | "fadeSlow"
  | "randomBlink"
  | "solid"
  | "twiceColor"
  | "builtIn"
  | "palette"
  | "fixedPattern";

type CommandParameters = AnimationParameters & { brightness: number };

type BuiltInPattern = {
  id: number;
  label: string;
  description: string;
  usesSpeed: boolean;
  minimumSpeed?: number;
};

const BUILT_IN_PATTERNS: BuiltInPattern[] = [
  { id: 1, label: "Five-color fade cycle", description: "Loops through five built-in RGBW colors at your selected speed.", usesSpeed: true, minimumSpeed: 1 },
  { id: 2, label: "20-color cycle", description: "Loops through 20 built-in colors at a firmware-fixed speed.", usesSpeed: false },
  { id: 3, label: "Lights off", description: "Turns the selected LED group off.", usesSpeed: false },
  { id: 4, label: "Random-color fade", description: "Fades toward randomly chosen firmware colors at a firmware-fixed speed.", usesSpeed: false },
  { id: 5, label: "Orange/red-orange fade", description: "Alternates between orange and red-orange at your selected speed.", usesSpeed: true, minimumSpeed: 1 },
  { id: 6, label: "Seven-color fade cycle", description: "Loops through seven built-in colors; the firmware adds 9 to your selected speed.", usesSpeed: true },
  { id: 7, label: "Static all-off", description: "Applies the static all-off preset.", usesSpeed: false },
  { id: 8, label: "Multicolor segments", description: "Applies a static multicolor segment pattern.", usesSpeed: false },
  { id: 9, label: "TWICE static preset", description: "Applies the static TWICE/0x65 preset.", usesSpeed: false },
];

const COMMAND_OPTIONS: Array<{ id: CommandMode; label: string; description: string; animationKey?: string }> = [
  { id: "blink", label: "Blink", description: "Blink one RGB color at a target rate", animationKey: "blink" },
  { id: "fadeFast", label: "Fade fast", description: "Fade between black and one RGB color", animationKey: "pulse" },
  { id: "fadeSlow", label: "Fade slow", description: "Fade between approximately 20% and full color", animationKey: "slowPulse" },
  { id: "randomBlink", label: "Random blink", description: "Cycle through the firmware random-color table", animationKey: "randomBlink" },
  { id: "solid", label: "Solid color", description: "Set a direct RGB color and brightness" },
  { id: "twiceColor", label: "TWICE color", description: "Adjust the shared scaling used by the TWICE preset", animationKey: "twiceShift" },
  { id: "builtIn", label: "Built-in animation", description: "Select one of the nine firmware patterns", animationKey: "builtIn" },
  { id: "palette", label: "Solid-color palette", description: "Select one of 28 device-defined solid colors" },
  { id: "fixedPattern", label: "Fixed-pattern rotation", description: "Rotate the built-in orange/red-orange pattern", animationKey: "hueSpin" },
];

const ANIMATION_KEY_BY_COMMAND: Partial<Record<CommandMode, string>> = Object.fromEntries(
  COMMAND_OPTIONS.filter((option) => option.animationKey).map((option) => [option.id, option.animationKey]),
);

function optionFor(mode: CommandMode) {
  return COMMAND_OPTIONS.find((option) => option.id === mode) || COMMAND_OPTIONS[0];
}

function builtInPatternFor(id: number) {
  return BUILT_IN_PATTERNS.find((pattern) => pattern.id === id) || BUILT_IN_PATTERNS[0];
}

function closestTierIndex(tiers: number[], target: number) {
  return tiers.reduce((bestIndex, rate, index) => (
    Math.abs(rate - target) < Math.abs(tiers[bestIndex] - target) ? index : bestIndex
  ), 0);
}

function formatRate(rate: number) {
  return rate.toFixed(2).replace(/\.?(0+)$/, "");
}

export function Controller({ state, setState, onBeforeCommand, notify }: {
  state: ControllerState;
  setState: Dispatch<SetStateAction<ControllerState>>;
  onBeforeCommand(): void;
  notify(message: string): void;
}) {
  const { snapshot, sendCommand } = useBluetoothSession();
  const adapter = (snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter;
  const [commandMode, setCommandMode] = useState<CommandMode>("solid");
  const [parameters, setParameters] = useState<CommandParameters>({
    color: state.color,
    brightness: state.brightness,
    speed: 14,
    hue: 10,
    animationId: 1,
    colorShift: 10,
  });
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [rateTierIndex, setRateTierIndex] = useState(0);
  const selectedOption = optionFor(commandMode);
  const animationKey = ANIMATION_KEY_BY_COMMAND[commandMode];
  const definition = animationKey ? adapter.customAnimations[animationKey] : null;
  const selectedBuiltInPattern = commandMode === "builtIn" ? builtInPatternFor(parameters.animationId) : null;
  const targetRateDefinition = definition?.targetRate;
  const targetRate = targetRateDefinition?.tiers[rateTierIndex] ?? 0;
  const previewBrightness = commandMode === "solid" ? parameters.brightness : state.brightness;
  const devicePreviewColor = previewColorFromHex(parameters.color, previewBrightness);
  const devicePreviewBackground = previewBackgroundFromHex(parameters.color, previewBrightness);
  const effectiveParameters = useMemo(() => ({
    ...parameters,
    speed: commandMode === "blink"
      ? (blinkSpeedForRate(targetRate) ?? parameters.speed)
      : commandMode === "randomBlink"
        ? (randomBlinkSpeedForRate(targetRate) ?? parameters.speed)
        : parameters.speed,
  }), [commandMode, parameters, targetRate]);
  const commandPacket = useMemo(() => {
    try {
      if (commandMode === "solid") return adapter.commands.staticColor(parameters.color, parameters.brightness);
      if (commandMode === "palette") return adapter.commands.factoryColor(paletteIndex);
      if (!definition) return new Uint8Array();
      return definition.packet(effectiveParameters);
    } catch {
      return new Uint8Array();
    }
  }, [adapter, commandMode, definition, effectiveParameters, paletteIndex, parameters.brightness, parameters.color]);

  async function run(packet: Uint8Array, label: string, update: Partial<ControllerState>) {
    onBeforeCommand();
    setState((current) => ({ ...current, lastCommand: `Sending ${label.toLowerCase()}…` }));
    try {
      await sendCommand(packet, label);
      setState((current) => ({ ...current, ...update, lastCommand: `${label} sent · ${packetLabel(packet)}` }));
      notify(`${label} applied`);
    } catch {
      setState((current) => ({ ...current, lastCommand: `${label} failed. Try again.` }));
      notify("The command could not be sent");
    }
  }

  function selectCommand(mode: CommandMode) {
    setCommandMode(mode);
    const key = ANIMATION_KEY_BY_COMMAND[mode];
    const next = key ? adapter.customAnimations[key] : null;
    if (next?.targetRate) {
      setRateTierIndex(closestTierIndex(next.targetRate.tiers, next.targetRate.defaultValue));
    }
    setParameters((current) => ({
      ...current,
      speed: mode === "fixedPattern"
        ? (next?.speed?.defaultValue ?? 1)
        : (next?.speed?.defaultValue ?? current.speed),
      hue: mode === "fixedPattern"
        ? 10
        : (next?.hue?.defaultValue ?? current.hue),
      animationId: next?.animationId?.defaultValue ?? current.animationId,
      colorShift: mode === "twiceColor"
        ? Math.min(10, next?.colorShift?.defaultValue ?? 10)
        : (next?.colorShift?.defaultValue ?? current.colorShift),
    }));
  }

  function updateCommandState(): Partial<ControllerState> {
    const colorCommand = commandMode === "blink" || commandMode === "fadeFast" || commandMode === "fadeSlow" || commandMode === "solid";
    const isOffPattern = commandMode === "builtIn" && (parameters.animationId === 3 || parameters.animationId === 7);
    return {
      color: colorCommand ? parameters.color : state.color,
      brightness: commandMode === "solid" ? parameters.brightness : state.brightness,
      poweredOff: isOffPattern,
      activeScene: null,
      activeAnimation: commandMode === "solid" || commandMode === "palette" ? null : commandMode,
    };
  }

  function selectBuiltInPattern(animationId: number) {
    const pattern = builtInPatternFor(animationId);
    setParameters((current) => ({
      ...current,
      animationId: pattern.id,
      speed: pattern.minimumSpeed ? Math.max(pattern.minimumSpeed, current.speed) : current.speed,
    }));
  }

  return (
    <div className="page controller-page">
      <div className="page-heading">
        <div><p className="eyebrow">LIGHT CONTROL</p><h1>Make it yours.</h1><p>Send documented safe lighting commands and adjust only the controls each command needs.</p></div>
      </div>

      <article className="card section-card">
        <div className="card-heading"><div><span className="section-label">SAFE LIGHTING COMMANDS</span><h2>Choose a command</h2></div><span className="helper">Protocol allow-list</span></div>
        <div className="builder-grid">
          <div className="builder-controls">
            <label className="field"><span>Command</span><select aria-label="Command" value={commandMode} onChange={(event) => selectCommand(event.target.value as CommandMode)}>{COMMAND_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>

            {(commandMode === "blink" || commandMode === "fadeFast" || commandMode === "fadeSlow" || commandMode === "solid") && <label className="field"><span>Color</span><span className="color-picker-row"><input className="large-color" type="color" value={parameters.color} onChange={(event) => setParameters((current) => ({ ...current, color: event.target.value }))} /><span className="color-preview-rectangle" role="img" aria-label={`Device preview ${devicePreviewColor}`} style={{ background: devicePreviewBackground }} /></span></label>}

            {(commandMode === "fadeFast" || commandMode === "fadeSlow") && definition?.speed && <RangeField label="Firmware speed" value={parameters.speed} minimum={definition.speed.minimum} maximum={definition.speed.maximum} output={`${parameters.speed} / ${definition.speed.maximum}`} onChange={(speed) => setParameters((current) => ({ ...current, speed }))} />}
            {(commandMode === "blink" || commandMode === "randomBlink") && targetRateDefinition && <RangeField label="Target blink rate" value={rateTierIndex} minimum={0} maximum={targetRateDefinition.tiers.length - 1} output={`${formatRate(targetRate)} blinks/min · speed ${effectiveParameters.speed}`} onChange={setRateTierIndex} />}
            {commandMode === "solid" && <RangeField label="Brightness" value={parameters.brightness} minimum={0} maximum={10} output={`${parameters.brightness} / 10`} onChange={(brightness) => setParameters((current) => ({ ...current, brightness }))} />}
            {commandMode === "twiceColor" && <RangeField label="TWICE scaling" value={parameters.colorShift} minimum={1} maximum={10} output={`${parameters.colorShift} / 10`} onChange={(colorShift) => setParameters((current) => ({ ...current, colorShift }))} />}
            {commandMode === "builtIn" && definition?.animationId && <label className="field"><span>Pattern</span><select aria-label="Built-in pattern" value={parameters.animationId} onChange={(event) => selectBuiltInPattern(Number(event.target.value))}>{BUILT_IN_PATTERNS.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}</select></label>}
            {commandMode === "builtIn" && selectedBuiltInPattern?.usesSpeed && definition?.speed && <RangeField label="Firmware speed" value={parameters.speed} minimum={selectedBuiltInPattern.minimumSpeed ?? definition.speed.minimum} maximum={definition.speed.maximum} output={`${parameters.speed} / ${definition.speed.maximum}`} onChange={(speed) => setParameters((current) => ({ ...current, speed }))} />}
            {commandMode === "palette" && <RangeField label="Palette index" value={paletteIndex} minimum={0} maximum={27} output={`0x${paletteIndex.toString(16).padStart(2, "0").toUpperCase()} / 0x1B`} onChange={setPaletteIndex} />}
            {commandMode === "fixedPattern" && definition?.speed && <RangeField label="Rotation speed" value={parameters.speed} minimum={0} maximum={3} output={`${parameters.speed} / 3`} onChange={(speed) => setParameters((current) => ({ ...current, speed }))} />}
            {commandMode === "fixedPattern" && <RangeField label="Pattern scaling" value={parameters.hue} minimum={0} maximum={10} output={`${parameters.hue} / 10`} onChange={(hue) => setParameters((current) => ({ ...current, hue }))} />}

            <button className="primary-button wide" type="button" disabled={snapshot.sending || commandPacket.length === 0} onClick={() => void run(commandPacket, selectedOption.label, updateCommandState())}>Send {selectedOption.label}</button>
            <div className={`command-line ${snapshot.sending ? "sending" : ""}`} role="status"><i />{state.lastCommand}</div>
          </div>
          <aside className="builder-summary">
            <span className="section-label">SELECTED COMMAND</span><h3>{selectedBuiltInPattern?.label ?? selectedOption.label}</h3><p>{selectedBuiltInPattern?.description ?? selectedOption.description}</p>
            <div className="packet-box"><span>Packet</span><code>{commandPacket.length ? packetLabel(commandPacket) : "—"}</code></div>
          </aside>
        </div>
      </article>

      <article className="card section-card">
        <div className="card-heading"><div><span className="section-label">POWER</span><h2>Lightstick power</h2></div></div>
        <div className="button-grid">
          <button className="dark-button" type="button" disabled={snapshot.sending} onClick={() => void run(adapter.commands.powerOn(), "Power on", { poweredOff: false })}>Turn on</button>
          <button className="secondary-button" type="button" disabled={snapshot.sending} onClick={() => void run(adapter.commands.powerOff(), "Power off", { poweredOff: true, activeScene: null, activeAnimation: null })}>Turn off</button>
        </div>
      </article>
    </div>
  );
}

export function RangeField({ label, value, minimum, maximum, output, onChange }: {
  label: string; value: number; minimum: number; maximum: number; output: string; onChange(value: number): void;
}) {
  const progress = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
  return <div className="range-field"><div><label>{label}</label><output>{output}</output></div><input type="range" min={minimum} max={maximum} value={value} style={{ "--progress": `${progress}%` } as React.CSSProperties} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}
