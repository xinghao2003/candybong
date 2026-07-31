# Candybong Infinity web controller

This is a dependency-free mobile prototype for the TWICE Candybong Infinity. The UI is device-agnostic, while `adapters.js` keeps each lightstick's Bluetooth names, GATT UUIDs, and packet encoders in a separate profile. New lightsticks can be added there without rewriting the controls.

The current profile uses the same Nordic UART Service command characteristic as the Android proof of concept:

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- Command characteristic: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`

Open `index.html` in Chrome on Android over HTTPS or localhost. On iPhone/iPad, Bluefy is the browser option to try because Safari does not expose Web Bluetooth. Turn on the lightstick, tap **Connect Bluetooth**, and then use power, solid color, brightness, or one-tap effects.

The animated effects use the firmware's full extended opcodes. In particular, color fade commands are `ff e2 00 RR GG BB SS` (faster fade) and `ff e3 00 RR GG BB SS` (slower fade). Pink Glow, Ocean Pulse, and White Pulse all send an animated fade command rather than a static color command.

The custom animation builder exposes all currently documented animation families with mode-specific limits:

- RGB blink (`e1`), pulse (`e2`), and slow pulse (`e3`) accept any 24-bit RGB color. Each channel ranges from 0 to 255, for 16,777,216 theoretical combinations.
- Random-color blink (`e4`) accepts a speed value but chooses its own colors.
- Hue rotation (`e7`) accepts speed 0–3 and hue 0–255.
- Built-in animation (`14`) accepts pattern ID 1–9 and speed 0–255.
- TWICE color shift (`13`) accepts shift 1–255 and remains experimental because its behavior is not fully reverse-engineered.

Solid-color brightness is a separate 0–10 value. Displayed colors can differ from the selected RGB value because the LEDs have a smaller real-world gamut than the mathematical RGB color space.

The Factory Palette Lab sends the device-defined color command `ff 15 00 II`, where `II` ranges from `00` through `1b`. The 28 colors have not been mapped to trustworthy names, so the lab lets a user test each physical result and save an observed label in browser local storage under `candybong-factory-palette-v1`.

The optional Diagnostics panel records transmitted command bytes and listens for responses on Nordic UART characteristic `6e400003-b5a3-f393-e0a9-e50e24dcca9e`. Notification setup is non-fatal: if the response endpoint is absent or does not support notifications, normal command control remains available and the panel reports RX as unavailable.

Important: opening `http://192.168.x.x:4173/` from the phone is not a secure context, so Bluetooth will be unavailable. For USB-local debugging, enable Android USB debugging and run `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/` on the phone. Otherwise use an HTTPS tunnel or HTTPS hosting.

For a quick local preview from the repository root:

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory web
```

Then open `http://127.0.0.1:4173/`.
