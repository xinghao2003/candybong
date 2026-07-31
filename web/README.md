# Candybong Infinity web controller

This is a dependency-free mobile prototype for the TWICE Candybong Infinity. The UI is device-agnostic, while `adapters.js` keeps each lightstick's Bluetooth names, GATT UUIDs, and packet encoders in a separate profile. New lightsticks can be added there without rewriting the controls.

The current profile uses the same Nordic UART Service command characteristic as the Android proof of concept:

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- Command characteristic: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`

Open `index.html` in Chrome on Android over HTTPS or localhost. On iPhone/iPad, Bluefy is the browser option to try because Safari does not expose Web Bluetooth. Turn on the lightstick, tap **Connect Bluetooth**, and then use power, solid color, brightness, or one-tap effects.

The animated effects use the firmware's full extended opcodes. In particular, color fade commands are `ff e2 00 RR GG BB SS` (faster fade) and `ff e3 00 RR GG BB SS` (slower fade). Pink Glow, Ocean Pulse, and White Pulse all send an animated fade command rather than a static color command.

Important: opening `http://192.168.x.x:4173/` from the phone is not a secure context, so Bluetooth will be unavailable. For USB-local debugging, enable Android USB debugging and run `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/` on the phone. Otherwise use an HTTPS tunnel or HTTPS hosting.

For a quick local preview from the repository root:

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory web
```

Then open `http://127.0.0.1:4173/`.
