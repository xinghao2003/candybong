# Candybong web app

A Vite, React, and TypeScript app for controlling and studying a TWICE Candybong Infinity through Web Bluetooth. The browser talks directly to the Nordic UART GATT profile; there is no backend.

## App structure

The connection gate is the only interface shown before a supported Candybong is connected. A normal connection opens the Controller. Published `?show=` links open Track Studio after connection.

The connected app has three tabs:

- **Controller** — power, solid RGB color, brightness, quick effects, and protocol-safe custom animations.
- **Tools** — Track Studio, Factory Palette, Latency Lab, Blink Lab, and Capture Lab. Only one tool is visible at a time; leaving it pauses media and stops sensors while preserving session data.
- **Device** — the browser-visible device/profile capabilities, Nordic UART endpoints, connection help, and the capped TX/RX diagnostics log.

On disconnect, active media, timers, measurements, and queued Bluetooth work are cancelled and the app returns to the connection gate. Harmless in-memory UI state remains available after reconnecting.

## Development

```powershell
npm install
npm run dev
```

The development server includes a **Use mock Candybong** option on the connection screen. It exercises the complete UI without Bluetooth hardware. Open the Device tab while connected to emit a simulated response, fail the next command, or simulate a disconnect. Mock controls are guarded by `import.meta.env.DEV` and are not shown in production builds.

Open the Vite URL through localhost. Real-device use requires a secure context and a Web Bluetooth browser. Chrome on Android is the primary target; iPhone and iPad require a browser that exposes Web Bluetooth.

Validation commands:

```powershell
npm run typecheck
npm test
npm run build
```

The production build keeps Vite's relative `base` so the generated files can be hosted below a static site subdirectory.

## Bluetooth safety boundary

`src/adapters.js` is the command allow-list. The UI sends only the documented power, static-color, factory-palette, and animation packet families already represented there. Do not add packet formats based only on an unverified firmware branch or an observed opcode.

The response characteristic is optional. If notifications are unavailable, normal command writes continue and Device reports the RX channel as unavailable.

## Track Studio

Track Studio imports browser-playable audio locally, renders its waveform, and schedules persistent lighting cues from the media element's playback clock. Exported `.candybong.json` files contain track metadata, cue timing, and lighting parameters but never embed the audio.

Published shows use a same-origin query link:

```text
https://example.com/candybong/?show=shows/my-song.candybong.json
```

The show JSON and referenced audio must both resolve on the app's origin. The version-1 show format and cue offset remain validated by `src/show-format.js`.

## Measurement limits

- Bluetooth write completion is not proof that the LEDs have visibly changed.
- Perceived-effect tests include human reaction time.
- Camera results include camera exposure and frame quantization.
- Device latency is browser-to-GATT write completion, not a radio-only measurement or visible LED response.
- The supplied TWICE firmware exposes Nordic UART rather than the standard Battery Service. Its custom `FF 16` query returns a discrete battery grade (`0x01..0x11`, with `0x11` as the full bucket and `0x20` unknown); the web app shows that grade and does not invent a percentage.
- Automated sound-to-light calibration requires both camera and microphone permission and should be treated as a physical measurement, not inferred protocol timing.
