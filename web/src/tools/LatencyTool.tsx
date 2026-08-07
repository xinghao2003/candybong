import { useEffect, useRef, useState } from "react";
import { LIGHTSTICK_ADAPTERS } from "../adapters.js";
import { useBluetoothSession } from "../bluetooth-session";
import { CameraLumaTracker, cameraErrorMessage } from "../camera-luma.js";
import { AlignmentGuide } from "../align-guide.js";
import { CALIBRATION_REPETITIONS, LatencyCalibrationSession, createCalibrationProfiles } from "../latency-calibration.js";
import type { ControllerState, LightstickAdapter } from "../domain";

function wait(ms: number) { return new Promise<void>((resolve) => window.setTimeout(resolve, ms)); }

export function LatencyTool({ active, controller, notify }: {
  active: boolean;
  controller: ControllerState;
  notify(message: string): void;
}) {
  const session = useBluetoothSession();
  const sessionRef = useRef(session); sessionRef.current = session;
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const adapter = (session.snapshot.adapter || LIGHTSTICK_ADAPTERS[0]) as LightstickAdapter;
  const calibrationVideoRef = useRef<HTMLVideoElement>(null);
  const calibrationFrameRef = useRef<HTMLDivElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const calibrationRef = useRef<any>(null);
  const calibrationGuideRef = useRef<AlignmentGuide | null>(null);
  const calibrationDebugRef = useRef<{
    recorder: MediaRecorder;
    chunks: Blob[];
    startedAt: number;
    startedAtIso: string;
    commands: Array<Record<string, unknown>>;
    report?: unknown;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("Ready to calibrate");
  const [report, setReport] = useState<any>(null);
  const [probes, setProbes] = useState<number[]>([]);
  const [probeRunning, setProbeRunning] = useState(false);
  const [calibrationCameraOn, setCalibrationCameraOn] = useState(false);
  const cameraTracker = useRef<any>(null);
  const cameraPendingAt = useRef<number | null>(null);
  const cameraTimeout = useRef(0);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraResult, setCameraResult] = useState<string>("Camera is off");

  useEffect(() => {
    if (!calibrationFrameRef.current || calibrationGuideRef.current) return;
    calibrationGuideRef.current = new (AlignmentGuide as any)({
      frame: calibrationFrameRef.current,
      hint: "Drag to move · pinch to resize",
      onRoiChange: (roi: number) => calibrationRef.current?.setRoi(roi),
      onPositionChange: (positionX: number, positionY: number) => calibrationRef.current?.setPosition(positionX, positionY),
    });
    return () => { calibrationGuideRef.current?.setVisible(false); };
  }, []);

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
    void calibrationRef.current?.stopPreview();
    calibrationRef.current = null;
    calibrationGuideRef.current?.setVisible(false);
    setCalibrationCameraOn(false);
    cameraTracker.current?.stop();
    setCameraOn(false);
    cameraPendingAt.current = null;
    window.clearTimeout(cameraTimeout.current);
  }, [active]);

  async function timedWrite(packet: Uint8Array, label: string) {
    const writeStart = performance.now();
    const debug = calibrationDebugRef.current;
    const commandEvent: Record<string, unknown> = {
      index: debug?.commands.length ?? null,
      label,
      packet: [...packet],
      sentAtMs: debug ? writeStart - debug.startedAt : null,
    };
    debug?.commands.push(commandEvent);
    try {
      await sessionRef.current.sendCommand(packet, label);
    } catch (error) {
      commandEvent.error = error instanceof Error ? error.message : String(error);
      commandEvent.failedAtMs = performance.now() - (debug?.startedAt ?? writeStart);
      throw error;
    }
    const writeComplete = performance.now();
    commandEvent.completedAtMs = debug ? writeComplete - debug.startedAt : null;
    commandEvent.writeMs = writeComplete - writeStart;
    return { writeStart, writeComplete, writeMs: writeComplete - writeStart, replyAt: null, replyMs: null, replyPacket: null };
  }

  function startDebugRecording(calibration: LatencyCalibrationSession) {
    if (calibrationDebugRef.current) return;
    const stream = calibration.getStream();
    if (!stream || typeof MediaRecorder === "undefined") {
      session.addDiagnostic("WARN", "Calibration debug recording unavailable");
      return;
    }
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find((candidate) => MediaRecorder.isTypeSupported(candidate));
    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const debug = {
        recorder,
        chunks: [] as Blob[],
        startedAt: performance.now(),
        startedAtIso: new Date().toISOString(),
        commands: [] as Array<Record<string, unknown>>,
      };
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size) debug.chunks.push(event.data); });
      recorder.start(250);
      calibrationDebugRef.current = debug;
      session.addDiagnostic("SYS", "Calibration debug recording started");
    } catch (error) {
      session.addDiagnostic("WARN", `Calibration debug recording unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function stopDebugRecording() {
    const debug = calibrationDebugRef.current;
    if (!debug) return;
    calibrationDebugRef.current = null;
    await new Promise<void>((resolve) => {
      const save = () => {
        const finishedAt = performance.now();
        const stamp = debug.startedAtIso.replace(/[:.]/g, "-");
        const videoBlob = new Blob(debug.chunks, { type: debug.recorder.mimeType || "video/webm" });
        const jsonBlob = new Blob([JSON.stringify({
          schema: "candybong-calibration-debug",
          version: 1,
          recordedAt: debug.startedAtIso,
          durationMs: finishedAt - debug.startedAt,
          videoFile: `candybong-calibration-${stamp}.webm`,
          commands: debug.commands,
          report: debug.report ?? null,
        }, null, 2)], { type: "application/json" });
        for (const [blob, suffix] of [[videoBlob, "webm"], [jsonBlob, "json"]] as const) {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `candybong-calibration-${stamp}.${suffix}`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }
        session.addDiagnostic("SYS", "Calibration debug video and command JSON saved");
        resolve();
      };
      if (debug.recorder.state === "inactive") { save(); return; }
      debug.recorder.addEventListener("stop", save, { once: true });
      debug.recorder.stop();
    });
  }

  function createCalibration() {
    if (!calibrationVideoRef.current) return null;
    const profiles = createCalibrationProfiles(adapter);
    const calibration = new LatencyCalibrationSession({
      video: calibrationVideoRef.current,
      profiles,
      powerOffPacket: adapter.commands.powerOff(),
      litBaselinePacket: adapter.commands.staticColor("#ffffff", 10),
      repetitions: CALIBRATION_REPETITIONS,
      writeCommand: (packet: Uint8Array) => timedWrite(packet, "Automated calibration"),
      isConnected: () => sessionRef.current.snapshot.status === "connected",
      onProgress: ({ definition, repetition, completed, total }: any) => setProgress(`${definition.label} · ${repetition}/${CALIBRATION_REPETITIONS} · ${completed}/${total}`),
      onSensorStatus: setProgress,
      metadata: { adapterId: adapter.id, userAgent: navigator.userAgent, profileCount: profiles.length },
    });
    calibration.setRoi(calibrationGuideRef.current?.roiFraction ?? 0.7);
    calibration.setPosition(calibrationGuideRef.current?.positionX ?? 0.5, calibrationGuideRef.current?.positionY ?? 0.5);
    calibrationRef.current = calibration;
    return calibration;
  }

  async function startCalibrationCamera() {
    if (running || calibrationCameraOn) return;
    const calibration = calibrationRef.current || createCalibration();
    if (!calibration) return;
    try {
      await calibration.startPreview();
      setCalibrationCameraOn(true);
      calibrationGuideRef.current?.setVisible(true);
    } catch (error) {
      calibrationRef.current = null;
      const message = error instanceof Error ? error.message : "Calibration camera could not start";
      notify(message);
    }
  }

  async function stopCalibrationCamera() {
    if (running) return;
    await calibrationRef.current?.stopPreview();
    calibrationRef.current = null;
    calibrationGuideRef.current?.setVisible(false);
    setCalibrationCameraOn(false);
  }

  async function runCalibration() {
    if (!calibrationVideoRef.current || running) return;
    if (cameraOn) {
      cameraTracker.current?.stop();
      setCameraOn(false);
      setCameraResult("Camera is off");
    }
    const calibration = calibrationRef.current || createCalibration();
    if (!calibration) return;
    setRunning(true); setReport(null);
    setCalibrationCameraOn(true);
    calibrationGuideRef.current?.setVisible(true);
    startDebugRecording(calibration);
    try {
      const next = await calibration.run();
      if (calibrationDebugRef.current) calibrationDebugRef.current.report = next;
      setReport(next);
      setProgress("Calibration complete");
      session.addDiagnostic("SYS", `Automated calibration complete · ${next.global.medianSoundToLightMs ?? "no"} ms median latency`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Calibration failed";
      setProgress(message); notify(message);
    } finally {
      await stopDebugRecording();
      setRunning(false);
      setCalibrationCameraOn(false);
      calibrationGuideRef.current?.setVisible(false);
      calibrationRef.current = null;
    }
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

  const medianSoundToLight = report?.global?.medianSoundToLightMs as number | null | undefined;
  const average = probes.length ? probes.reduce((sum, value) => sum + value, 0) / probes.length : null;
  return <div className="tool-content latency-tool"><div className="tool-intro"><p>Measure Bluetooth transport and camera-observed light response. Optical results include camera frame timing.</p><span className={`tool-badge ${running ? "active" : ""}`}>{running ? "Running" : "Ready"}</span></div><article className="card calibration-card"><div className="card-heading"><div><span className="section-label">AUTOMATED</span><h2>Sound-to-light calibration</h2></div></div><p>Start the camera first to position the lightstick inside the circle. Then run {CALIBRATION_REPETITIONS} solid-color on trials and {CALIBRATION_REPETITIONS} solid-color off trials; the result is their median latency.</p><div className="camera-frame calibration-camera-frame" ref={calibrationFrameRef} hidden={!calibrationCameraOn}><video className="calibration-video" ref={calibrationVideoRef} muted playsInline autoPlay hidden /></div><div className="action-row"><button className="primary-button" type="button" disabled={running || calibrationCameraOn} onClick={() => void startCalibrationCamera()}>Start camera</button><button className="secondary-button" type="button" disabled={running || !calibrationCameraOn} onClick={() => void stopCalibrationCamera()}>Stop camera</button><button className="secondary-button" type="button" disabled={!calibrationCameraOn} onClick={() => calibrationGuideRef.current?.reset()}>Reset circle</button><button className="primary-button" type="button" disabled={running || !calibrationCameraOn} onClick={() => void runCalibration()}>Run calibration</button><button className="secondary-button" type="button" disabled={!running} onClick={() => calibrationRef.current?.cancel()}>Cancel</button></div><p className="result-line">{report ? medianSoundToLight == null ? "No valid latency measured" : `Median sound-to-light latency ${Math.round(medianSoundToLight)} ms` : progress}</p></article><div className="lab-grid three"><article className="card"><span className="section-label">BLUETOOTH WRITE</span><h2>Five transport probes</h2><p>Measures browser-to-GATT write completion, not visible LED response.</p><button className="primary-button wide" type="button" disabled={probeRunning} onClick={() => void runProbes()}>{probeRunning ? `Probe ${probes.length + 1} of 5…` : "Run 5 probes"}</button><p className="result-line">{average == null ? "No probes yet" : `Average ${average.toFixed(1)} ms · ${probes.map((value) => Math.round(value)).join(" / ")} ms`}</p></article><article className="card"><span className="section-label">CAMERA FLASH</span><h2>Visible LED response</h2><p>Measures from command start until the camera sees the Candybong brighten.</p><video className="camera-mini" ref={cameraVideoRef} muted playsInline autoPlay hidden /><div className="action-row"><button className="secondary-button" type="button" onClick={() => void toggleCamera()}>{cameraOn ? "Stop camera" : "Start camera"}</button><button className="primary-button" type="button" disabled={!cameraOn} onClick={() => void runCameraFlash()}>Run flash test</button></div><p className="result-line">{cameraResult}</p></article></div></div>;
}
