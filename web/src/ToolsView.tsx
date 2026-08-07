import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { LIGHTSTICK_ADAPTERS } from "./adapters.js";
import { BlinkLab } from "./blink-lab.js";
import { useBluetoothSession } from "./bluetooth-session";
import { CaptureGuide } from "./capture-guide.js";
import { cueModeLabel } from "./show-format.js";
import { TrackStudio } from "./track-studio.js";
import type { ControllerState, LightstickAdapter, ToolId } from "./domain";
import { LatencyTool } from "./tools/LatencyTool";

const TOOL_CARDS: Array<{ id: ToolId; icon: string; title: string; description: string; badge: string }> = [
  { id: "studio", icon: "♫", title: "Track Studio", description: "Build a synchronized light show for a song.", badge: "Audio" },
  { id: "latency", icon: "↯", title: "Latency Lab", description: "Measure transport, perception, and light response.", badge: "Camera + mic" },
  { id: "capture", icon: "▣", title: "Capture Lab", description: "Capture an aligned 224 × 224 lightstick image.", badge: "Camera" },
];

export function ToolsView({ active, activeTool, setActiveTool, controller, setController, manualControlSignal, notify }: {
  active: boolean;
  activeTool: ToolId | null;
  setActiveTool(tool: ToolId | null): void;
  controller: ControllerState;
  setController: Dispatch<SetStateAction<ControllerState>>;
  manualControlSignal: number;
  notify(message: string): void;
}) {
  const studioRef = useRef<any>(null);
  const selected = TOOL_CARDS.find((tool) => tool.id === activeTool);

  return (
    <div className="page tools-page">
      {!activeTool ? (
        <>
          <div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Go deeper.</h1><p>Choreograph songs, study timing, and explore what your Candybong can do.</p></div></div>
          <div className="tool-picker">
            {TOOL_CARDS.map((tool) => <button className="tool-card" key={tool.id} type="button" onClick={() => setActiveTool(tool.id)}><span className="tool-icon">{tool.icon}</span><span><strong>{tool.title}</strong><small>{tool.description}</small></span><span className="tool-badge">{tool.badge}</span><b>›</b></button>)}
          </div>
        </>
      ) : (
        <div className="tool-shell-heading"><button className="back-button" type="button" onClick={() => setActiveTool(null)}>‹ <span>Tools</span></button><div><span className="section-label">{selected?.badge}</span><h1>{selected?.title}</h1></div></div>
      )}

      <div hidden={activeTool !== "studio"}><TrackStudioTool active={active && activeTool === "studio"} controller={controller} setController={setController} manualControlSignal={manualControlSignal} notify={notify} onReady={(instance) => { studioRef.current = instance; }} /></div>
      <div hidden={activeTool !== "latency"}><LatencyTool active={active && activeTool === "latency"} controller={controller} notify={notify} applyStudioOffset={(offset) => studioRef.current?.setCueOffsetMs(offset)} /></div>
      <div hidden={activeTool !== "capture"}><CaptureLabTool active={active && activeTool === "capture"} notify={notify} /></div>
    </div>
  );
}

function TrackStudioTool({ active, controller, setController, manualControlSignal, notify, onReady }: {
  active: boolean;
  controller: ControllerState;
  setController: Dispatch<SetStateAction<ControllerState>>;
  manualControlSignal: number;
  notify(message: string): void;
  onReady(instance: any): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<any>(null);
  const latest = useRef({ controller, setController, notify });
  latest.current = { controller, setController, notify };
  const session = useBluetoothSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (instanceRef.current || !rootRef.current) return;
    instanceRef.current = new TrackStudio({
      root: rootRef.current,
      onCue: async (cue: any) => {
        const { snapshot, sendCommand } = sessionRef.current;
        const adapter = (snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter;
        const definition = cue.mode === "off" || cue.mode === "solid" ? null : adapter.customAnimations[cue.mode];
        latest.current.setController((current) => ({
          ...current,
          color: cue.color,
          brightness: cue.brightness,
          poweredOff: cue.mode === "off" || (cue.mode === "solid" && cue.brightness === 0),
          activeScene: null,
          activeAnimation: definition ? cue.mode : null,
          previewColor: definition ? (definition.usesColor ? cue.color : definition.previewColor || cue.color) : cue.color,
          previewEffect: definition?.previewEffect || "solid",
          previewName: cue.label || cueModeLabel(cue.mode),
          previewDescription: `Timeline cue at ${cue.time.toFixed(2)} seconds`,
        }));
        if (snapshot.status !== "connected") return false;
        const packet = cue.mode === "off"
          ? adapter.commands.powerOff()
          : cue.mode === "solid"
            ? adapter.commands.staticColor(cue.color, cue.brightness)
            : definition?.packet({ color: cue.color, speed: cue.speed, hue: cue.hue, animationId: cue.animationId, colorShift: cue.colorShift });
        if (!packet) return false;
        try { await sendCommand(packet, `Track cue · ${cue.label || cueModeLabel(cue.mode)}`); return true; }
        catch { latest.current.notify("Timeline cue could not be sent"); return false; }
      },
      onPlaybackChange: (playing: boolean) => {
        if (playing) sessionRef.current.addDiagnostic("SYS", "Track Studio playback started");
      },
      onNotice: (message: string) => latest.current.notify(message),
    });
    onReady(instanceRef.current);
  }, [onReady]);

  useEffect(() => {
    if (!active) instanceRef.current?.pauseForManualControl();
    else instanceRef.current?.render();
  }, [active]);
  useEffect(() => { if (manualControlSignal) instanceRef.current?.pauseForManualControl(); }, [manualControlSignal]);

  return <div className="tool-content studio-tool" ref={rootRef}>
    <div className="tool-intro"><p>Import a song, seek to a moment, and add a light cue. Audio stays in this browser.</p><span className="local-pill">LOCAL AUDIO</span></div>
    <div className="file-row"><label className="primary-button file-button"><input data-studio="trackFile" type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.opus" />Import audio</label><label className="secondary-button file-button"><input data-studio="showFile" type="file" accept="application/json,.json" />Open show JSON</label><div><strong data-studio="trackName">No track loaded</strong><span data-studio="trackMeta">Choose a browser-playable audio file</span></div></div>
    <audio className="studio-audio" data-studio="audio" controls preload="metadata" hidden />
    <div className="timeline-card"><canvas data-studio="waveform" aria-label="Audio waveform and animation cue timeline" /><div className="timeline-toolbar"><button data-studio="zoomOut" type="button" disabled>−</button><output data-studio="zoomRange">Full track</output><button data-studio="zoomIn" type="button" disabled>+</button><button data-studio="zoomReset" type="button" disabled>Fit</button><label>Cue offset <input data-studio="cueOffset" type="number" min="0" max="1000" step="10" defaultValue="0" /> ms</label></div><div className="timeline-time"><output data-studio="time">0:00.00</output><span>Drag to seek · right-drag to pan · blink dots repeat until the next cue</span><output data-studio="duration">0:00.00</output></div></div>
    <div className="studio-status" data-studio="status" role="status">Import a track to start authoring.</div>
    <div className="studio-editor-grid"><div className="cue-editor"><div className="form-grid"><label className="field"><span>Cue time (seconds)</span><input data-studio="cueTime" type="number" min="0" step="0.01" defaultValue="0" /></label><label className="field"><span>Animation</span><select data-studio="cueMode" defaultValue="solid"><option value="solid">Solid color</option><option value="off">Lights off</option><option value="blink">Color blink</option><option value="pulse">Color pulse</option><option value="slowPulse">Slow color pulse</option><option value="randomBlink">Random-color blink</option><option value="hueSpin">Hue rotation</option><option value="builtIn">Built-in animation</option><option value="twiceShift">TWICE color shift · experimental</option></select></label></div><label className="field"><span>Label (optional)</span><input data-studio="cueLabel" type="text" maxLength={80} placeholder="Example: chorus starts" /></label><div className="form-grid"><label className="field" data-cue-field="solid blink pulse slowPulse"><span>Color</span><input data-studio="cueColor" type="color" defaultValue="#ff5fa2" /></label><label className="field" data-cue-field="solid"><span>Brightness</span><input data-studio="cueBrightness" type="number" min="0" max="10" defaultValue="10" /></label><label className="field" data-cue-field="blink randomBlink"><span>Target blink rate</span><input data-studio="cueRate" type="range" min="0" max="95" defaultValue="0" /><output data-studio="cueRateOutput">—</output></label><label className="field" data-cue-field="pulse slowPulse hueSpin builtIn"><span>Firmware speed</span><input data-studio="cueSpeed" type="number" min="0" max="255" defaultValue="14" /></label><label className="field" data-cue-field="hueSpin"><span>Starting hue</span><input data-studio="cueHue" type="number" min="0" max="255" defaultValue="16" /></label><label className="field" data-cue-field="builtIn"><span>Pattern ID</span><input data-studio="cueAnimationId" type="number" min="1" max="9" defaultValue="1" /></label><label className="field" data-cue-field="twiceShift"><span>Color shift</span><input data-studio="cueColorShift" type="number" min="1" max="255" defaultValue="16" /></label></div><div className="action-row"><button className="primary-button" data-studio="addCue" type="button" disabled>Add cue</button><button className="secondary-button" data-studio="updateCue" type="button" disabled>Update selected</button><button className="secondary-button" data-studio="deleteCue" type="button" disabled>Delete</button></div></div><aside className="cue-list-card"><div><span className="section-label">CUE LIST</span><button className="text-button" data-studio="clearCues" type="button" disabled>Clear</button></div><p data-studio="cueEmpty">No cues yet. Put the playhead on a moment and add one.</p><ol data-studio="cueList" /></aside></div>
    <div className="export-row"><div><strong>Portable show file</strong><span>Timing and light commands only; audio is never copied.</span></div><button className="dark-button" data-studio="exportShow" type="button" disabled>Export show JSON</button></div>
  </div>;
}

const FACTORY_KEY = "candybong-factory-palette-v1";
const FACTORY_DEFAULTS: Record<number, string> = { 0x00: "Dahyun", 0x01: "Chaeyoung", 0x02: "Jihyo", 0x06: "Jeongyeon", 0x0d: "Mina", 0x10: "Nayeon", 0x12: "Tzuyu", 0x16: "Sana", 0x1b: "Momo" };

function FactoryPaletteTool({ setController, notify }: { controller: ControllerState; setController: Dispatch<SetStateAction<ControllerState>>; notify(message: string): void }) {
  const { snapshot, sendCommand, addDiagnostic } = useBluetoothSession();
  const adapter = (snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter;
  const [selected, setSelected] = useState(0);
  const [entries, setEntries] = useState<Record<string, { label: string; tested: boolean }>>(() => { try { return JSON.parse(localStorage.getItem(FACTORY_KEY) || "{}"); } catch { return {}; } });
  const current = entries[selected] || { label: FACTORY_DEFAULTS[selected] || "", tested: false };
  const testedCount = Object.values(entries).filter((entry) => entry.tested).length;

  function save(entry: { label: string; tested: boolean }) {
    const next = { ...entries, [selected]: entry };
    setEntries(next); localStorage.setItem(FACTORY_KEY, JSON.stringify(next));
  }

  async function testColor() {
    try {
      await sendCommand(adapter.commands.factoryColor(selected), `Factory color ${selected.toString(16).padStart(2, "0").toUpperCase()}`);
      save({ ...current, tested: true });
      setController((state) => ({ ...state, poweredOff: false, activeScene: null, activeAnimation: null, previewColor: "#d9cfd5", previewEffect: "solid", previewName: current.label || `Factory color ${selected.toString(16).padStart(2, "0").toUpperCase()}`, previewDescription: "Device-defined palette color", lastCommand: `Factory color ${selected.toString(16).padStart(2, "0").toUpperCase()} sent` }));
      notify("Factory color applied");
    } catch { notify("Factory color could not be sent"); }
  }

  return <div className="tool-content"><div className="tool-intro"><p>These colors are generated inside the Candybong. Test an index, observe it physically, and save your own label.</p><span className="tool-badge">{testedCount} / 28 tested</span></div><div className="palette-grid">{Array.from({ length: 28 }, (_, index) => { const entry = entries[index]; return <button key={index} type="button" className={`${selected === index ? "active" : ""} ${entry?.tested ? "tested" : ""}`} onClick={() => setSelected(index)}><strong>{index.toString(16).padStart(2, "0").toUpperCase()}</strong><small>{entry?.label || FACTORY_DEFAULTS[index] || "Unknown"}</small></button>; })}</div><div className="palette-editor card"><div><span className="section-label">SELECTED COLOR</span><h2>{current.label || `Index ${selected.toString(16).padStart(2, "0").toUpperCase()}`}</h2><code>FF 15 00 {selected.toString(16).padStart(2, "0").toUpperCase()}</code></div><label className="field"><span>Observed color label</span><input value={current.label} maxLength={32} placeholder="Example: warm white" onChange={(event) => save({ ...current, label: event.target.value })} /></label><div className="action-row"><button className="primary-button" type="button" disabled={snapshot.sending} onClick={() => void testColor()}>Test index {selected.toString(16).padStart(2, "0").toUpperCase()}</button><button className="secondary-button" type="button" onClick={() => { save({ label: "", tested: false }); addDiagnostic("SYS", `Cleared factory palette index ${selected}`); }}>Clear result</button></div></div></div>;
}

function BlinkLabTool({ active, controller, setController, notify }: { active: boolean; controller: ControllerState; setController: Dispatch<SetStateAction<ControllerState>>; notify(message: string): void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<any>(null);
  const latest = useRef({ controller, notify }); latest.current = { controller, notify };
  const session = useBluetoothSession(); const sessionRef = useRef(session); sessionRef.current = session;
  useEffect(() => {
    if (instanceRef.current || !rootRef.current) return;
    instanceRef.current = new BlinkLab({ root: rootRef.current, getConnected: () => sessionRef.current.snapshot.status === "connected", getColor: () => latest.current.controller.color, onColorChange: (color: string) => setController((state) => ({ ...state, color })), sendBlink: async (color: string, speed: number, label: string) => { const adapter = (sessionRef.current.snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter; try { await sessionRef.current.sendCommand(adapter.customAnimations.blink.packet({ color, speed, hue: 0, animationId: 1, colorShift: 1 }), label); setController((state) => ({ ...state, color, poweredOff: false, activeScene: null, activeAnimation: "blink", previewColor: color, previewEffect: "blink", previewName: "Color blink", previewDescription: `Firmware speed ${speed}` })); return true; } catch { return false; } }, onDiagnostic: (direction: any, label: string, packet?: Uint8Array) => sessionRef.current.addDiagnostic(direction, label, packet), onToast: (message: string) => latest.current.notify(message) });
  }, [setController]);
  useEffect(() => {
    if (!active) {
      instanceRef.current?.onDisconnected();
      instanceRef.current?.stopCamera();
    } else {
      instanceRef.current?.setConnected(true);
    }
  }, [active, session.snapshot.status]);
  return <div className="tool-content blink-tool" ref={rootRef}><div className="tool-intro"><p>Measure real blink timing through the camera and fit a speed-to-rate mapping for this lightstick.</p><span className="tool-badge" data-blinklab="status">Camera off</span></div><div className="lab-grid"><div className="card"><label className="field"><span>Blink color</span><div className="inline-color"><input data-blinklab="color" type="color" defaultValue="#ff5fa2" /><i data-blinklab="colorSwatch" /><code data-blinklab="colorHex">#FF5FA2</code></div></label><div className="range-field"><div><label>Firmware speed</label><input className="number-inline" data-blinklab="speedNumber" type="number" min="0" max="255" defaultValue="12" /></div><input data-blinklab="speed" type="range" min="0" max="255" defaultValue="12" /></div><div className="range-field"><div><label>Detection threshold</label><output data-blinklab="thresholdValue">15%</output></div><input data-blinklab="threshold" type="range" min="5" max="50" step="5" defaultValue="15" /></div><button className="primary-button wide" data-blinklab="applySpeed" type="button" disabled>Blink at speed 12</button><div className="action-row"><button className="secondary-button" data-blinklab="startCamera" type="button" disabled>Start camera</button><button className="secondary-button" data-blinklab="stopCamera" type="button" disabled>Stop</button><button className="text-button" data-blinklab="resetGuide" type="button" disabled>Reset circle</button></div></div><div className="card camera-card"><div className="camera-frame" data-blinklab="previewFrame"><video data-blinklab="preview" muted playsInline autoPlay hidden /></div><div data-blinklab="analysis" hidden><div className="signal-row"><span data-blinklab="stateDot" /><div><strong data-blinklab="signalState">Waiting for signal</strong><small data-blinklab="signalDetail">Point the camera at the lightstick</small></div></div><div className="meter"><span data-blinklab="lumaFill" /></div><output data-blinklab="lumaValue">0%</output><div data-blinklab="lumaMeter" role="meter" aria-valuemin={0} aria-valuemax={100} /><div className="stat-grid"><div><span>Blinks</span><strong data-blinklab="blinkCount">0</strong></div><div><span>Latest period</span><strong data-blinklab="latestPeriod">—</strong></div><div><span>Median rate</span><strong data-blinklab="medianRate">—</strong></div></div></div></div></div><div className="card section-card"><div className="card-heading"><div><span className="section-label">CALIBRATION SWEEP</span><h2>Fit this Candybong</h2></div><div className="action-row"><button className="primary-button small" data-blinklab="startSweep" type="button" disabled>Run sweep</button><button className="secondary-button small" data-blinklab="stopSweep" type="button" disabled>Stop</button></div></div><p data-blinklab="sweepSummary">No sweep yet</p><table data-blinklab="table" hidden><thead><tr><th>Speed</th><th>Period</th><th>Rate</th></tr></thead><tbody data-blinklab="tableBody" /></table><p data-blinklab="fitLine" /><div className="mapping-row"><span data-blinklab="mappingLabel">Mapping: built-in formula</span><button className="text-button" data-blinklab="resetMapping" type="button" disabled>Reset to default</button></div><div className="range-field"><div><label>Target blinks/min</label><output data-blinklab="targetValue">60</output></div><input data-blinklab="target" type="range" min="10" max="600" defaultValue="60" /></div><p data-blinklab="targetLine">Built-in formula: target 60 blinks/min → speed 17.</p><button className="primary-button wide" data-blinklab="applyTarget" type="button" disabled>Apply target rate</button></div></div>;
}

function CaptureLabTool({ active, notify }: { active: boolean; notify(message: string): void }) {
  const rootRef = useRef<HTMLDivElement>(null); const instanceRef = useRef<any>(null); const session = useBluetoothSession(); const sessionRef = useRef(session); sessionRef.current = session;
  useEffect(() => { if (!instanceRef.current && rootRef.current) instanceRef.current = new (CaptureGuide as any)({ root: rootRef.current, onDiagnostic: (direction: any, label: string, packet?: Uint8Array) => sessionRef.current.addDiagnostic(direction, label, packet), onToast: notify }); }, [notify]);
  useEffect(() => { if (!active) instanceRef.current?.stopCamera(); }, [active]);
  return <div className="tool-content" ref={rootRef}><div className="tool-intro"><p>Center the Candybong head inside the guide, then capture the exact aligned crop used by vision experiments.</p><span className="tool-badge" data-capture="status">Camera off</span></div><div className="capture-layout"><div className="card camera-card"><div className="camera-frame" data-capture="frame"><video data-capture="preview" muted playsInline autoPlay hidden /></div><div className="action-row"><button className="primary-button" data-capture="startCamera" type="button">Start camera</button><button className="secondary-button" data-capture="stopCamera" type="button" disabled>Stop</button><button className="secondary-button" data-capture="reset" type="button" disabled>Reset circle</button><button className="dark-button" data-capture="captureButton" type="button" disabled>Capture 224 × 224</button></div></div><div className="card capture-result"><p data-capture="resultText">No capture yet</p><canvas data-capture="resultCanvas" width="224" height="224" hidden /></div></div></div>;
}
