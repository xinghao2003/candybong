import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BluetoothSessionProvider } from "./bluetooth-session";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Application root is missing");

createRoot(root).render(
  <StrictMode>
    <BluetoothSessionProvider>
      <App />
    </BluetoothSessionProvider>
  </StrictMode>,
);
