import { useEffect, useRef, useState } from "react";
import { LIGHTSTICK_ADAPTERS } from "../adapters.js";
import { useBluetoothSession } from "../bluetooth-session";
import { CameraLumaTracker, cameraErrorMessage } from "../camera-luma.js";
import { CALIBRATION_REPETITIONS, LatencyCalibrationSession, createCalibrationProfiles } from "../latency-calibration.js";
import type { ControllerState, LightstickAdapter } from "../domain";

function wait(ms: number) { return new Promise<void>((resolve) => window.setTimeout(resolve, ms)); }

export function LatencyTool({ active, controller, notify, applyStudioOffset }: {
  active: boolean;
  controller: ControllerState;
  notify(message: string): void;
  applyStudioOffset(offset: number): void;
}) {
  const session = useBluetoothSession();
  const sessionRef = useRef(session); sessionRef.current = session;
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const adapter = (session.snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter;
  const calibrationVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const calibrationRef = useRef<any>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("Ready to calibrate");
  const [report, setReport] = useState<any>(null);
  const [probes, setProbes] = useState<number[]>([]);
  const [probeRunning, setProbeRunning] = useState(false);
  const [tapPhase, setTapPhase] = useState<"idle" | "waiting" | "armed">("idle");
  const [tapResult, setTapResult] = useState<number | null>(null);
  const tapTimer = useRef(0);
  const tapStarted = useRef<number | null>(null);
  const cameraTracker = useRef<any>(null);
  const cameraPendingAt = useRef<number | null>(null);
  const cameraTimeout = useRef(0);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraResult, setCameraResult] = useState<string>("Camera is off");

  useEffect(() => {
    cameraTracker.current = new (CameraLumaTracker as any)({
      signal: "bright",
      onSample: (sample: any) => {
        if (cameraPendingAt.current == null || sample.edge !== "rise") return;
        const elapsed = Math.max(0, sample.edgeAt - cameraPendingAt.current);
        cameraPendingAt.current = null;
        window.clearTimeout(cameraTimeout.current);
        setCameraResult(`Visible change detected in ${Math.round(elapsed)} ms`);
        sessionRef.current.addDiagnostic("SYS", `Camera flash detected · ${Math.round(elapsed)} ms`);
        void restoreLight();
      },
      onEnded: () => { setCameraOn(false); setCameraResult("Camera input ended"); },
    });
    return () => cameraTracker.current?.stop();
  }, []);

  useEffect(() => {
    if (active) return;
    calibrationRef.current?.cancel();
    cameraTracker.current?.stop();
    setCameraOn(false);
    cameraPendingAt.current = null;
    window.clearTimeout(cameraTimeout.current);
    window.clearTimeout(tapTimer.current);
    setTapPhase("idle");
  }, [active]);

  async function timedWrite(packet: Uint8Array, label: string) {
    const writeStart = performance.now();
    await sessionRef.current.sendCommand(packet, label);
    const writeComplete = performance.now();
    return { writeStart, writeComplete, writeMs: writeComplete - writeStart, replyAt: null, replyMs: null, replyPacket: null };
  }

  async function runCalibration() {
    if (!calibrationVideoRef.current || running) return;
    if (cameraOn) {
      cameraTracker.current?.stop();
      setCameraOn(false);
      setCameraResult("Camera is off");
    }
    const profiles = createCalibrationProfiles(adapter);
    const calibration = new LatencyCalibrationSession({
      video: calibrationVideoRef.current,
      profiles,
      powerOffPacket: adapter.commands.powerOff(),
      litBaselinePacket: adapter.commands.staticColor("#ff5fa2", 10),
      repetitions: CALIBRATION_REPETITIONS,
      writeCommand: (packet: Uint8Array) => timedWrite(packet, "Automated calibration"),
      isConnected: () => sessionRef.current.snapshot.status === "connected",
      onProgress: ({ definition, repetition, completed, total }: any) => setProgress(`${definition.label} · ${repetition}/${CALIBRATION_REPETITIONS} · ${completed}/${total}`),
      onSensorStatus: setProgress,
      metadata: { adapterId: adapter.id, userAgent: navigator.userAgent, profileCount: profiles.length },
    });
    calibrationRef.current = calibration;
    setRunning(true); setReport(null);
    try {
      const next = await calibration.run();
      setReport(next);
      setProgress("Calibration complete");
      session.addDiagnostic("SYS", `Automated calibration complete · ${next.global.recommendedCueOffsetMs ?? "no"} ms recommended offset`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Calibration failed";
      setProgress(message); notify(message);
    } finally { setRunning(false); calibrationRef.current = null; }
  }

  async function runProbes() {
    if (probeRunning) return;
    setProbeRunning(true); setProbes([]);
    const values: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      try {
        const result = await timedWrite(adapter.commands.staticColor(index % 2 ? "#ff5fa2" : "#ffffff", 10), `Latency probe ${index + 1} of 5`);
        values.push(result.writeMs); setProbes([...values]);
        await wait(250);
      } catch { break; }
    }
    setProbeRunning(false);
  }

  function startTap() {
    setTapResult(null); setTapPhase("waiting");
    const delay = 700 + Math.random() * 1300;
    tapTimer.current = window.setTimeout(async () => {
      tapStarted.current = performance.now();
      try { await session.sendCommand(adapter.commands.factoryColor(0x00), "Perceived latency flash"); setTapPhase("armed"); }
      catch { setTapPhase("idle"); notify("Latency flash could not be sent"); }
    }, delay);
  }

  function finishTap() {
    if (tapPhase !== "armed" || tapStarted.current == null) return;
    const elapsed = performance.now() - tapStarted.current;
    setTapResult(elapsed); setTapPhase("idle"); tapStarted.current = null;
    session.addDiagnostic("SYS", `Perceived latency tap · ${Math.round(elapsed)} ms`);
    void restoreLight();
  }

  async function restoreLight() {
    const current = controllerRef.current;
    const packet = current.poweredOff ? adapter.commands.powerOff() : adapter.commands.staticColor(current.color, current.brightness);
    try { await sessionRef.current.sendCommand(packet, "Latency restore"); } catch { /* logged by session */ }
  }

  async function toggleCamera() {
    if (cameraOn) { cameraTracker.current.stop(); setCameraOn(false); setCameraResult("Camera is off"); return; }
    if (!cameraVideoRef.current) return;
    try { await cameraTracker.current.start(cameraVideoRef.current); setCameraOn(true); setCameraResult("Camera ready · center the lightstick"); }
    catch (error) { notify(cameraErrorMessage(error)); }
  }

  async function runCameraFlash() {
    if (!cameraOn || cameraPendingAt.current != null) return;
    try {
      await session.sendCommand(adapter.commands.powerOff(), "Camera flash baseline");
      await wait(400);
      cameraPendingAt.current = performance.now();
      await session.sendCommand(adapter.commands.factoryColor(0x00), "Camera latency flash");
      setCameraResult("Waiting for the visible change…");
      cameraTimeout.current = window.setTimeout(() => { cameraPendingAt.current = null; setCameraResult("No visible change detected within 4 seconds"); void restoreLight(); }, 4000);
    } catch { cameraPendingAt.current = null; notify("Camera flash could not be sent"); }
  }

  const recommended = report?.global?.recommendedCueOffsetMs as number | null | undefined;
  const average = probes.length ? probes.reduce((sum, value) => sum + value, 0) / probes.length : null;
  return <div className="tool-content latency-tool"><div className="tool-intro"><p>Separate Bluetooth acknowledgement, human reaction, and camera-observed light response. Optical results still include camera frame timing.</p><span className={`tool-badge ${running ? "active" : ""}`}>{running ? "Running" : "Ready"}</span></div><article className="card calibration-card"><div className="card-heading"><div><span className="section-label">RECOMMENDED</span><h2>Automated sound-to-light calibration</h2></div></div><p>Runs {CALIBRATION_REPETITIONS} trials across every safe command profile using a synchronized click, microphone, and camera.</p><video className="calibration-video" ref={calibrationVideoRef} muted playsInline autoPlay hidden /><div className="action-row"><button className="primary-button" type="button" disabled={running} onClick={() => void runCalibration()}>Run automated calibration</button><button className="secondary-button" type="button" disabled={!running} onClick={() => calibrationRef.current?.cancel()}>Cancel</button><button className="secondary-button" type="button" disabled={recommended == null} onClick={() => { if (recommended != null) { applyStudioOffset(recommended); notify(`Cue offset set to ${recommended} ms`); } }}>Apply offset</button><button className="secondary-button" type="button" disabled={!report} onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "candybong-latency-calibration.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }}>Export JSON</button></div><p className="result-line">{report ? recommended == null ? "No applicable global offset" : `Recommended cue offset ${recommended} ms` : progress}</p></article><div className="lab-grid three"><article className="card"><span className="section-label">BLUETOOTH WRITE</span><h2>Five transport probes</h2><p>Measures browser-to-GATT write completion, not visible LED response.</p><button className="primary-button wide" type="button" disabled={probeRunning} onClick={() => void runProbes()}>{probeRunning ? `Probe ${probes.length + 1} of 5…` : "Run 5 probes"}</button><p className="result-line">{average == null ? "No probes yet" : `Average ${average.toFixed(1)} ms · ${probes.map((value) => Math.round(value)).join(" / ")} ms`}</p></article><article className="card"><span className="section-label">PERCEIVED EFFECT</span><h2>Tap when it flashes</h2><p>Includes human reaction time. A random delay prevents anticipation.</p><button className={`primary-button wide tap-button ${tapPhase === "armed" ? "armed" : ""}`} type="button" disabled={tapPhase === "waiting"} onClick={tapPhase === "armed" ? finishTap : startTap}>{tapPhase === "waiting" ? "Wait for the flash…" : tapPhase === "armed" ? "Tap now" : "Start test"}</button><p className="result-line">{tapResult == null ? "Not tested yet" : `${Math.round(tapResult)} ms including reaction time`}</p></article><article className="card"><span className="section-label">CAMERA FLASH</span><h2>Visible LED response</h2><p>Measures from command start until the camera sees the Candybong brighten.</p><video className="camera-mini" ref={cameraVideoRef} muted playsInline autoPlay hidden /><div className="action-row"><button className="secondary-button" type="button" onClick={() => void toggleCamera()}>{cameraOn ? "Stop camera" : "Start camera"}</button><button className="primary-button" type="button" disabled={!cameraOn} onClick={() => void runCameraFlash()}>Run flash test</button></div><p className="result-line">{cameraResult}</p></article></div></div>;
}
