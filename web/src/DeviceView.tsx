import { useEffect, useState } from "react";
import { useBluetoothSession } from "./bluetooth-session";
import { packetLabel } from "./domain";

function durationLabel(startedAt: number | null, now: number): string {
  if (!startedAt) return "Not connected";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function DeviceView({ onDisconnect }: { onDisconnect(): void }) {
  const { snapshot, clearDiagnostics, emitMockResponse, failNextMockCommand, simulateMockDisconnect } = useBluetoothSession();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const adapter = snapshot.adapter;

  return (
    <div className="page device-page">
      <div className="page-heading"><div><p className="eyebrow">DEVICE</p><h1>Your Candybong.</h1><p>Connection details, Bluetooth capabilities, and a transparent command log.</p></div><button className="secondary-button disconnect-button" type="button" onClick={onDisconnect}>Disconnect</button></div>

      <div className="device-grid">
        <article className="card device-identity">
          <div className="device-orb"><span>C</span></div>
          <div><span className="section-label">CONNECTED LIGHTSTICK</span><h2>{snapshot.deviceName}</h2><p>{adapter?.label}</p></div>
          <span className="connected-pill"><i />{snapshot.isMock ? "Mock device" : "Online"}</span>
        </article>
        <article className="card facts-card">
          <div className="card-heading"><div><span className="section-label">SESSION</span><h2>Connection facts</h2></div></div>
          <dl className="facts-list">
            <div><dt>Profile</dt><dd>{adapter?.id || "—"}</dd></div>
            <div><dt>Connected for</dt><dd>{durationLabel(snapshot.connectedAt, now)}</dd></div>
            <div><dt>Command writes</dt><dd>{snapshot.writeWithResponse ? "With response" : snapshot.writeWithoutResponse ? "Without response" : "Browser fallback"}</dd></div>
            <div><dt>Response channel</dt><dd className={snapshot.responseStatus === "listening" ? "success-text" : "muted-text"}>{snapshot.responseStatus === "listening" ? "Listening" : "Unavailable"}</dd></div>
          </dl>
        </article>
      </div>

      {import.meta.env.DEV && snapshot.isMock && (
        <article className="card section-card mock-controls-card">
          <div className="card-heading"><div><span className="section-label">DEVELOPMENT MOCK</span><h2>Simulate device states</h2></div><span className="tool-badge active">No hardware</span></div>
          <p className="card-copy">Exercise response, error, and connection-loss UI without sending Bluetooth commands.</p>
          <div className="action-row">
            <button className="secondary-button" type="button" onClick={emitMockResponse}>Emit response</button>
            <button className="secondary-button" type="button" onClick={failNextMockCommand}>Fail next command</button>
            <button className="secondary-button" type="button" onClick={simulateMockDisconnect}>Simulate disconnect</button>
          </div>
        </article>
      )}

      <article className="card section-card">
        <div className="card-heading"><div><span className="section-label">BLUETOOTH PROFILE</span><h2>Nordic UART endpoints</h2></div><span className="helper">Browser-accessible facts</span></div>
        <dl className="endpoint-list">
          <div><dt>Primary service</dt><dd><code>{String(adapter?.serviceUuid || "—")}</code></dd></div>
          <div><dt>Command characteristic</dt><dd><code>{String(adapter?.commandUuid || "—")}</code></dd></div>
          <div><dt>Response characteristic</dt><dd><code>{String(adapter?.responseUuid || "—")}</code></dd></div>
        </dl>
        <p className="info-note">Battery level and firmware version are not exposed by the connected profile, so the app does not guess them.</p>
      </article>

      <article className="card section-card diagnostics-card">
        <div className="card-heading"><div><span className="section-label">DIAGNOSTICS</span><h2>Packet and response log</h2></div><button className="secondary-button small" type="button" onClick={clearDiagnostics} disabled={!snapshot.diagnostics.length}>Clear log</button></div>
        <p className="card-copy">TX entries are commands written by this app. RX entries are optional notifications returned by the lightstick.</p>
        {snapshot.diagnostics.length ? (
          <ol className="diagnostic-list">
            {snapshot.diagnostics.map((entry) => (
              <li key={entry.id} className={`diagnostic-${entry.direction.toLowerCase()}`}>
                <span className="diagnostic-direction">{entry.direction}</span>
                <div><strong>{entry.label}</strong>{entry.bytes && <code>{packetLabel(entry.bytes)}</code>}</div>
                <time>{new Date(entry.at).toLocaleTimeString([], { hour12: false })}</time>
              </li>
            ))}
          </ol>
        ) : <div className="empty-state"><span>⌁</span><strong>No packets recorded yet</strong><p>Use the Controller or a tool and activity will appear here.</p></div>}
      </article>

      <article className="card section-card help-card">
        <div><span className="section-label">CONNECTION HELP</span><h2>Keep the link stable</h2></div>
        <ul><li>Keep the Candybong awake and close to your phone or computer.</li><li>Use HTTPS or localhost in Chrome on Android, or a Web Bluetooth browser on iPhone and iPad.</li><li>If it disconnects, the app returns to the connection screen without deleting this session&apos;s work.</li></ul>
      </article>
    </div>
  );
}
