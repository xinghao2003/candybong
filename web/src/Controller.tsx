import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { LIGHTSTICK_ADAPTERS, blinkSpeedForRate } from "./adapters.js";
import { useBluetoothSession } from "./bluetooth-session";
import type { AnimationParameters, ControllerState, LightstickAdapter } from "./domain";
import { packetLabel } from "./domain";

const PRESET_COLORS = ["#ff5fa2", "#ff4068", "#38c8ff", "#8b6cff", "#5de2a5", "#ffffff"];

export function Controller({ state, setState, onBeforeCommand, notify }: {
  state: ControllerState;
  setState: Dispatch<SetStateAction<ControllerState>>;
  onBeforeCommand(): void;
  notify(message: string): void;
}) {
  const { snapshot, sendCommand } = useBluetoothSession();
  const adapter = (snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter;
  const animationNames = Object.keys(adapter.customAnimations);
  const [animationMode, setAnimationMode] = useState(animationNames.includes("pulse") ? "pulse" : animationNames[0]);
  const definition = adapter.customAnimations[animationMode];
  const [parameters, setParameters] = useState<AnimationParameters>({
    color: "#ff5fa2", speed: 14, hue: 16, animationId: 1, colorShift: 16,
  });
  const [targetRate, setTargetRate] = useState(60);
  const effectiveParameters = useMemo(() => ({
    ...parameters,
    speed: animationMode === "blink" ? (blinkSpeedForRate(targetRate) ?? parameters.speed) : parameters.speed,
  }), [animationMode, parameters, targetRate]);
  const animationPacket = useMemo(() => {
    try { return definition.packet(effectiveParameters); } catch { return new Uint8Array(); }
  }, [definition, effectiveParameters]);

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

  function chooseColor(color: string) {
    const normalized = color.toLowerCase();
    setState((current) => ({
      ...current,
      color: normalized,
      poweredOff: current.brightness === 0,
      activeScene: null,
      activeAnimation: null,
      previewColor: normalized,
      previewEffect: "solid",
      previewName: normalized === "#ff5fa2" ? "Candy pink" : "Custom color",
      previewDescription: `Solid color · brightness ${current.brightness}`,
    }));
  }

  const previewColor = state.previewColor;

  return (
    <div className="page controller-page">
      <div className="page-heading">
        <div><p className="eyebrow">LIGHT CONTROL</p><h1>Make it yours.</h1><p>Choose a color, adjust brightness, or explore the Candybong&apos;s built-in animations.</p></div>
      </div>

      <div className="controller-hero-grid">
        <article className="card preview-card">
          <div className="card-heading"><div><span className="section-label">LIVE PREVIEW</span><h2>{state.previewName}</h2></div><span className="mode-pill">{state.activeAnimation || state.activeScene ? "Effect" : state.poweredOff ? "Off" : "Solid"}</span></div>
          <div className={`light-preview ${state.poweredOff ? "off" : ""}`} data-effect={state.previewEffect} style={{ "--light-color": previewColor, "--light-alpha": String(Math.max(0.08, state.brightness / 10)) } as React.CSSProperties}>
            <div className="preview-glow" /><div className="preview-disc"><span>TWICE</span></div>
          </div>
          <div className="preview-meta"><div><strong>{state.previewName}</strong><span>{state.previewDescription}</span></div><code>{previewColor.toUpperCase()}</code></div>
          <div className={`command-line ${snapshot.sending ? "sending" : ""}`}><i />{state.lastCommand}</div>
        </article>

        <div className="controller-stack">
          <article className="card">
            <div className="card-heading"><div><span className="section-label">POWER</span><h2>Lightstick power</h2></div></div>
            <div className="button-grid">
              <button className="dark-button" type="button" disabled={snapshot.sending} onClick={() => void run(adapter.commands.powerOn(), "Power on", { poweredOff: false, previewDescription: "Lightstick powered on" })}>Turn on</button>
              <button className="secondary-button" type="button" disabled={snapshot.sending} onClick={() => void run(adapter.commands.powerOff(), "Power off", { poweredOff: true, activeScene: null, activeAnimation: null, previewEffect: "solid", previewName: "Lightstick off", previewDescription: "Turn it on to continue" })}>Turn off</button>
            </div>
          </article>

          <article className="card">
            <div className="card-heading"><div><span className="section-label">SOLID COLOR</span><h2>Color and brightness</h2></div><label className="color-input"><input type="color" value={state.color} onChange={(event) => chooseColor(event.target.value)} /><span style={{ background: state.color }} /></label></div>
            <div className="color-presets" aria-label="Quick colors">
              {PRESET_COLORS.map((color) => <button key={color} type="button" className={state.color === color ? "active" : ""} style={{ "--preset": color } as React.CSSProperties} onClick={() => chooseColor(color)} aria-label={`Select ${color}`} />)}
            </div>
            <RangeField label="Brightness" value={state.brightness} minimum={0} maximum={10} output={`${state.brightness} / 10`} onChange={(brightness) => setState((current) => ({ ...current, brightness, poweredOff: brightness === 0, activeScene: null, activeAnimation: null, previewColor: current.color, previewEffect: "solid", previewName: current.color === "#ff5fa2" ? "Candy pink" : "Custom color", previewDescription: `Solid color · brightness ${brightness}` }))} />
            <button className="primary-button wide" type="button" disabled={snapshot.sending} onClick={() => void run(adapter.commands.staticColor(state.color, state.brightness), "Solid color", { poweredOff: state.brightness === 0, activeScene: null, activeAnimation: null, previewColor: state.color, previewEffect: "solid", previewName: state.color === "#ff5fa2" ? "Candy pink" : "Custom color", previewDescription: `Solid color · brightness ${state.brightness}` })}>Apply solid color</button>
          </article>
        </div>
      </div>

      <article className="card section-card">
        <div className="card-heading"><div><span className="section-label">QUICK EFFECTS</span><h2>Tap to animate</h2></div><span className="helper">Applied immediately</span></div>
        <div className="effect-grid">
          {Object.entries(adapter.scenes).map(([id, scene]) => (
            <button className={`effect-card ${state.activeScene === id ? "active" : ""}`} key={id} type="button" disabled={snapshot.sending} onClick={() => void run(scene.packet(), scene.name, { poweredOff: false, activeScene: id, activeAnimation: null, color: scene.color, previewColor: scene.color, previewEffect: scene.previewEffect, previewName: scene.name, previewDescription: scene.description })}>
              <span className="effect-dot" style={{ "--effect-color": scene.color } as React.CSSProperties} /><span><strong>{scene.name}</strong><small>{scene.description}</small></span><b>✓</b>
            </button>
          ))}
        </div>
      </article>

      <article className="card section-card">
        <div className="card-heading"><div><span className="section-label">ANIMATION LAB</span><h2>Build a custom effect</h2></div><span className="helper">Protocol-safe controls</span></div>
        <div className="builder-grid">
          <div className="builder-controls">
            <label className="field"><span>Animation family</span><select value={animationMode} onChange={(event) => { const mode = event.target.value; const next = adapter.customAnimations[mode]; setAnimationMode(mode); setParameters((current) => ({ ...current, speed: next.speed?.defaultValue ?? current.speed, hue: next.hue?.defaultValue ?? current.hue, animationId: next.animationId?.defaultValue ?? current.animationId, colorShift: next.colorShift?.defaultValue ?? current.colorShift })); }}>{Object.entries(adapter.customAnimations).map(([id, item]) => <option key={id} value={id}>{item.name}{item.experimental ? " · experimental" : ""}</option>)}</select></label>
            {definition.usesColor && <label className="field"><span>Animation color</span><input className="large-color" type="color" value={parameters.color} onChange={(event) => setParameters((current) => ({ ...current, color: event.target.value }))} /></label>}
            {definition.speed && animationMode !== "blink" && <RangeField label="Firmware speed" value={parameters.speed} minimum={definition.speed.minimum} maximum={definition.speed.maximum} output={`${parameters.speed} / ${definition.speed.maximum}`} onChange={(speed) => setParameters((current) => ({ ...current, speed }))} />}
            {animationMode === "blink" && <RangeField label="Target blink rate" value={targetRate} minimum={10} maximum={600} output={`${targetRate} blinks/min · speed ${effectiveParameters.speed}`} onChange={setTargetRate} />}
            {definition.hue && <RangeField label="Starting hue" value={parameters.hue} minimum={definition.hue.minimum} maximum={definition.hue.maximum} output={`${parameters.hue} / 255`} onChange={(hue) => setParameters((current) => ({ ...current, hue }))} />}
            {definition.animationId && <RangeField label="Built-in pattern" value={parameters.animationId} minimum={definition.animationId.minimum} maximum={definition.animationId.maximum} output={`${parameters.animationId} / 9`} onChange={(animationId) => setParameters((current) => ({ ...current, animationId }))} />}
            {definition.colorShift && <RangeField label="Color shift" value={parameters.colorShift} minimum={definition.colorShift.minimum} maximum={definition.colorShift.maximum} output={`${parameters.colorShift} / 255`} onChange={(colorShift) => setParameters((current) => ({ ...current, colorShift }))} />}
            <button className="primary-button wide" type="button" disabled={snapshot.sending} onClick={() => void run(animationPacket, definition.name, { poweredOff: false, activeScene: null, activeAnimation: animationMode, previewColor: definition.usesColor ? parameters.color : definition.previewColor || state.color, previewEffect: definition.previewEffect, previewName: definition.name, previewDescription: definition.description })}>Apply custom animation</button>
          </div>
          <aside className="builder-summary">
            <span className="summary-orb" style={{ "--effect-color": definition.usesColor ? parameters.color : definition.previewColor || "#8b6cff" } as React.CSSProperties} />
            <span className="section-label">SELECTED EFFECT</span><h3>{definition.name}</h3><p>{definition.description}</p>
            {definition.experimental && <span className="warning-pill">Experimental</span>}
            <div className="packet-box"><span>Packet preview</span><code>{packetLabel(animationPacket)}</code></div>
          </aside>
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
