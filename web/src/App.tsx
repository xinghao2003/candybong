import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBluetoothSession } from "./bluetooth-session";
import { Controller } from "./Controller";
import { DeviceView } from "./DeviceView";
import { ToolsView } from "./ToolsView";
import type { AppTab, ControllerState, ToolId } from "./domain";

const VALID_TABS = new Set<AppTab>(["controller", "tools", "device"]);
const THEME_STORAGE_KEY = "candybong-theme";
type Theme = "light" | "dark";

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Browsers can deny storage access; the system preference is still useful.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function tabFromHash(): AppTab {
  const value = window.location.hash.slice(1) as AppTab;
  return VALID_TABS.has(value) ? value : "controller";
}

const initialControllerState: ControllerState = {
  color: "#ff5fa2",
  brightness: 10,
  poweredOff: false,
  activeScene: null,
  activeAnimation: null,
  previewColor: "#ff5fa2",
  previewEffect: "solid",
  previewName: "Candy pink",
  previewDescription: "Solid color · brightness 10",
  lastCommand: "Connected · no command sent yet",
};

export function App() {
  const { snapshot, connect, connectMock, disconnect } = useBluetoothSession();
  const [tab, setTabState] = useState<AppTab>(tabFromHash);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [controller, setController] = useState<ControllerState>(initialControllerState);
  const [manualControlSignal, setManualControlSignal] = useState(0);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(0);
  const connected = snapshot.status === "connected";
  const publishedShow = useMemo(() => new URLSearchParams(window.location.search).get("show"), []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme switching remains functional when persistent storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    const handleHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", handleHash);
    if (!VALID_TABS.has(window.location.hash.slice(1) as AppTab)) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#controller`);
    }
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  const selectTab = useCallback((next: AppTab) => {
    if (next === tab) return;
    window.location.hash = next;
    setTabState(next);
  }, [tab]);

  const handleConnect = useCallback(async () => {
    const success = await connect();
    if (!success) return;
    if (publishedShow) {
      setActiveTool("studio");
      selectTab("tools");
    } else {
      selectTab(tabFromHash());
    }
  }, [connect, publishedShow, selectTab]);

  const handleMockConnect = useCallback(async () => {
    const success = await connectMock();
    if (!success) return;
    if (publishedShow) {
      setActiveTool("studio");
      selectTab("tools");
    } else {
      selectTab(tabFromHash());
    }
  }, [connectMock, publishedShow, selectTab]);

  const beginManualControl = useCallback(() => setManualControlSignal((value) => value + 1), []);

  return (
    <>
      {!connected && <ConnectionGate onConnect={handleConnect} onConnectMock={handleMockConnect} theme={theme} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} />}
      <div className="app" hidden={!connected} aria-hidden={!connected}>
        <header className="app-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">C</span>
            <div><strong>Candybong</strong><span>{snapshot.deviceName || "TWICE LightStick"}</span></div>
          </div>
          <div className="header-actions">
            <span className="connected-pill"><i />Connected</span>
            <ThemeToggle theme={theme} onToggle={() => setTheme((value) => value === "dark" ? "light" : "dark")} />
            <button className="icon-button" type="button" onClick={disconnect} aria-label="Disconnect Candybong" title="Disconnect">×</button>
          </div>
        </header>

        <main className="app-content">
          <section className="tab-view" hidden={tab !== "controller"} aria-labelledby="tab-controller">
            <Controller
              state={controller}
              setState={setController}
              onBeforeCommand={beginManualControl}
              notify={notify}
            />
          </section>
          <section className="tab-view" hidden={tab !== "tools"} aria-labelledby="tab-tools">
            <ToolsView
              active={connected && tab === "tools"}
              activeTool={activeTool}
              setActiveTool={setActiveTool}
              controller={controller}
              setController={setController}
              manualControlSignal={manualControlSignal}
              notify={notify}
            />
          </section>
          <section className="tab-view" hidden={tab !== "device"} aria-labelledby="tab-device">
            <DeviceView onDisconnect={disconnect} />
          </section>
        </main>

        <nav className="app-tabs" aria-label="Main navigation" role="tablist" onKeyDown={(event) => {
          const order: AppTab[] = ["controller", "tools", "device"];
          const current = order.indexOf(tab);
          const next = event.key === "ArrowRight" ? order[(current + 1) % order.length]
            : event.key === "ArrowLeft" ? order[(current + order.length - 1) % order.length]
              : event.key === "Home" ? order[0] : event.key === "End" ? order[order.length - 1] : null;
          if (!next) return;
          event.preventDefault(); selectTab(next); window.setTimeout(() => document.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus(), 0);
        }}>
          <TabButton id="controller" label="Controller" icon="◉" current={tab} onSelect={selectTab} />
          <TabButton id="tools" label="Tools" icon="◇" current={tab} onSelect={selectTab} />
          <TabButton id="device" label="Device" icon="⌁" current={tab} onSelect={selectTab} />
        </nav>
      </div>
      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </>
  );
}

function ConnectionGate({ onConnect, onConnectMock, theme, onToggleTheme }: {
  onConnect(): Promise<void>;
  onConnectMock(): Promise<void>;
  theme: Theme;
  onToggleTheme(): void;
}) {
  const { snapshot } = useBluetoothSession();
  const busy = snapshot.status === "requesting" || snapshot.status === "connecting";
  return (
    <main className="connection-gate">
      <div className="gate-ambient gate-ambient-one" />
      <div className="gate-ambient gate-ambient-two" />
      <section className="gate-card" aria-labelledby="gate-title">
        <div className="gate-toolbar"><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
        <div className="gate-logo" aria-hidden="true"><span>C</span></div>
        <p className="eyebrow">TWICE CANDYBONG INFINITY</p>
        <h1 id="gate-title">Connect your Candybong</h1>
        <p className="gate-copy">Turn on your lightstick and keep it nearby. Your browser connects directly over Bluetooth.</p>
        <div className="gate-actions">
          <button className="primary-button gate-button" type="button" onClick={() => void onConnect()} disabled={busy || snapshot.status === "unsupported"}>
            <span aria-hidden="true">ᛒ</span>{busy ? (snapshot.status === "requesting" ? "Choose your Candybong…" : "Connecting…") : "Connect with Bluetooth"}
          </button>
          {import.meta.env.DEV && <button className="secondary-button mock-connect-button" type="button" onClick={() => void onConnectMock()} disabled={busy}>Use mock Candybong</button>}
        </div>
        <div className={`gate-status ${snapshot.status === "error" || snapshot.status === "unsupported" ? "error" : ""}`} role="status">
          <i />{snapshot.errorMessage || snapshot.supportMessage}
        </div>
        <p className="gate-help">Requires HTTPS or localhost and a Web Bluetooth browser.</p>
      </section>
    </main>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle(): void }) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button className="theme-toggle" type="button" onClick={onToggle} aria-label={`Switch to ${nextTheme} mode`} title={`Switch to ${nextTheme} mode`}>
      <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
      <span className="theme-toggle-label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

function TabButton({ id, label, icon, current, onSelect }: {
  id: AppTab;
  label: string;
  icon: string;
  current: AppTab;
  onSelect(tab: AppTab): void;
}) {
  const selected = current === id;
  return (
    <button id={`tab-${id}`} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} className={selected ? "active" : ""} onClick={() => onSelect(id)}>
      <span aria-hidden="true">{icon}</span><strong>{label}</strong>
    </button>
  );
}
