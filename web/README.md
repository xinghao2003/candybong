# Candybong Infinity web controller

This is a dependency-free mobile prototype for the TWICE Candybong Infinity. The UI is device-agnostic, while `adapters.js` keeps each lightstick's Bluetooth names, GATT UUIDs, and packet encoders in a separate profile. New lightsticks can be added there without rewriting the controls.

The current profile uses the same Nordic UART Service command characteristic as the Android proof of concept:

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- Command characteristic: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`

Open `index.html` in Chrome on Android over HTTPS or localhost. On iPhone/iPad, Bluefy is the browser option to try because Safari does not expose Web Bluetooth. Turn on the lightstick, tap **Connect Bluetooth**, and then use power, solid color, brightness, or one-tap effects.

The animated effects use the firmware's full extended opcodes. In particular, color fade commands are `ff e2 00 RR GG BB SS` (faster fade) and `ff e3 00 RR GG BB SS` (slower fade). Pink Glow, Ocean Pulse, and White Pulse all send an animated fade command rather than a static color command.

## Music Reactive mode

Music Reactive mode uses the browser microphone and Web Audio API; it does not require Spotify or upload audio anywhere. Connect the Candybong, choose an effect, tap **Start listening**, and allow microphone access. Play music through a nearby speaker while keeping the controller page in the foreground.

- Volume pulse maps the live input level to brightness using the selected solid color.
- Bass beat flash detects short low-frequency peaks and flashes the selected solid color.
- Spectrum color maps low, mid, and high frequency energy to red, green, and blue.

Sensitivity changes how strongly quiet audio reacts, while maximum brightness caps the light output. Reactive packets are rate-limited to eight writes per second, duplicate frames are skipped, and diagnostics sample at most one reactive packet per second so the log remains useful. A manual power, color, effect, or factory-palette command stops microphone mode before writing, preventing concurrent Bluetooth commands.

Microphone limitations still apply: headphones and the phone's internal app audio cannot be captured directly, and browser echo cancellation may affect music played from the same phone. A separate speaker or music device works best. Microphone capture requires HTTPS or localhost just like Web Bluetooth, and support in iOS Web Bluetooth browsers such as Bluefy should be verified on the target device.

The custom animation builder exposes all currently documented animation families with mode-specific limits:

- RGB blink (`e1`), pulse (`e2`), and slow pulse (`e3`) accept any 24-bit RGB color. Each channel ranges from 0 to 255, for 16,777,216 theoretical combinations.
- Random-color blink (`e4`) accepts a speed value but chooses its own colors.
- Hue rotation (`e7`) accepts speed 0–3 and hue 0–255.
- Built-in animation (`14`) accepts pattern ID 1–9 and speed 0–255.
- TWICE color shift (`13`) accepts shift 1–255 and remains experimental because its behavior is not fully reverse-engineered.

Solid-color brightness is a separate 0–10 value. Displayed colors can differ from the selected RGB value because the LEDs have a smaller real-world gamut than the mathematical RGB color space.

## Track Studio

Track Studio authors repeatable light shows for a specific song entirely in the browser:

1. Import a browser-playable audio file. The file stays on the device; Web Audio only decodes it locally to draw the waveform.
2. Seek with the audio controls, or click and drag the waveform. Zoom with the − / + / Fit buttons or scroll over the waveform; the window anchors at the playhead (buttons) or the cursor (scroll), and cue markers and the playhead follow the zoom. Right-drag (or middle-drag) on the waveform pans the zoomed window. During playback the window pans to keep the playhead visible. Ctrl+scroll is intentionally left to the browser, which reserves it for whole-page zoom.
3. Choose a solid color, off command, or firmware animation and add it at the current timestamp. The cue time field always follows the playhead, so you can scrub to the next moment and add another cue right away.
4. Select a cue from the waveform or cue list to edit its time and parameters. Drag a cue marker along the waveform to move it to a new timestamp (the audio seeks along so you can hear the new position).
5. Play the track to preview the sequence. If a Candybong is connected, each cue is also written over Bluetooth; otherwise the on-page light is updated as a visual preview.
6. Export a `.candybong.json` show file. The JSON includes track metadata and ordered cues, but never embeds or copies the audio.

Effects are persistent device states: a cue takes effect at its timestamp and remains active until the next cue. Seeking applies the last cue at or before the new playhead position; the cue list highlights that active cue without rewriting the editor form. The audio element's `currentTime` is the playback clock, avoiding a second timer that can drift away from the song.

For a published show, host the licensed audio file and its exported JSON together, then link to the app with the JSON path in a query parameter:

```text
https://example.com/candybong/?show=shows/my-song.candybong.json
```

The app loads the JSON and the track filename recorded inside it from the same web origin. Same-origin loading is intentional: it avoids silently sending show viewers to third-party audio hosts. Only publish music you have permission to distribute.

Track playback should remain in the foreground for the most consistent timing. Bluetooth writes have device and browser latency, so the **cue offset** control in the timeline toolbar sends each cue early by the configured number of milliseconds — a cue at 10.2 s with a 300 ms offset fires when the playhead reaches 9.9 s, so the light changes with the music. Calibrate the value with the Latency Lab panel (perceived-effect result minus your reaction time is a good starting point), and the offset is stored in the exported show file so each venue's calibration travels with the show. Seeking still previews correctly under the offset schedule: a seek that lands between a cue's effective time and its real timestamp re-fires the overdue cue.

The Factory Palette Lab sends the device-defined color command `ff 15 00 II`, where `II` ranges from `00` through `1b`. Nine physically observed member-color candidates are included as provisional labels: Dahyun `00`, Chaeyoung `01`, Jihyo `02`, Jeongyeon `09`, Mina `0b`, Nayeon `0e`, Tzuyu `14`, Sana `16`, and Momo `1b`. These are not an official firmware mapping and can be confirmed or replaced in the lab. User observations are saved in browser local storage under `candybong-factory-palette-v1` and take precedence over the provisional labels.

The optional Diagnostics panel records transmitted command bytes and listens for responses on Nordic UART characteristic `6e400003-b5a3-f393-e0a9-e50e24dcca9e`. Notification setup is non-fatal: if the response endpoint is absent or does not support notifications, normal command control remains available and the panel reports RX as unavailable.

## Latency Lab

The Latency Lab panel (above Diagnostics) measures command-to-effect delay with three mechanisms:

- **Bluetooth round-trip** sends five alternating color probes and times each one twice: the *write* time (how long the device takes to acknowledge the ATT write) and, when the device sends response notifications, the *RX echo* time from TX write to the response arriving. This is derived entirely from the TX/RX traffic the Diagnostics log records, and covers the Bluetooth path only — not the LED's own reaction time. Probes with no response are reported as "no echo".
- **Perceived effect** flashes the light white after a short random delay (700–2000 ms so the tap cannot be anticipated) and measures how long until you tap the button. The result includes human reaction time (~150–250 ms), so subtract your personal reaction time when planning choreography. Results accumulate as last / best / average across taps.
- **Camera flash** starts the webcam pointed at the lightstick, flashes the light white, and times the write until the camera sees the visible change (and the restore edge back to the previous color). It covers the Bluetooth path plus the LED's own reaction and excludes human reaction time — but it includes camera capture and frame quantization (~33–100 ms), so treat it as an upper bound. The light is put on a steady color first so the flash is the only brightness change the camera sees.

All tests pause track playback and music-reactive mode first, restore the previous light state afterwards, and log their TX packets (and any RX echoes) in the Diagnostics log. Disconnecting mid-test cancels and cleans up the pending probe.

## Blink Lab

The firmware speed value (0–255) of the color-blink command has no documented relationship to how fast the light actually blinks. The Blink Lab (between Latency Lab and Diagnostics) measures the real blink frequency with the webcam and calibrates the speed value against it:

1. Choose a color and speed, then tap **Blink at speed N**. The blink command is sent as usual; the light starts blinking at that speed value.
2. Tap **Start camera** and point it at the lit lightstick so it fills a good part of the frame; a dim background helps. The frame-brightness meter shows the detected on/off signal, and the stats show the number of blinks, the latest period, and the median rate in blinks/min. Detection uses frame brightness only, so a dark blink color is hard to measure (a warning appears).
3. **Run sweep** steps through speeds 10 / 40 / 100 / 180 / 255, measuring each for five blink cycles. Higher speed values blink slower, so each row's timeout starts from the previous measured row's period (30 s floor) and extends further as the real periods arrive; rows that still time out are skipped and the sweep continues. A least-squares line is fitted to period vs speed and shown with its R² — the fit needs at least two measured rows.
4. Once a fit exists, the target-rate slider converts any target blinks/min into a speed value (inverse of the fit, clamped to the 0–255 firmware range) and **Apply target rate** sends that blink command.

The sweep color is captured when the sweep starts and the inputs are locked while it runs. Until a sweep has fitted a line, the target-rate slider uses a built-in piecewise formula fitted to observed candybong behaviour: a shifted rational decay from 617 blinks/min at speed 0 down to 12 at speed 50, then a log-linear tail to 3 blinks/min at speed 255. A successful sweep replaces the built-in formula with your lightstick's own fit — the mapping label shows which is active — and **Reset to default** restores the built-in formula. Everything is analyzed locally in the browser; the video never leaves the device. The calibration is per-device: it depends on the camera's frame rate and exposure as well as the lightstick.

Two camera realities shape the limits of this lab. First, browsers cannot lock camera auto-exposure, so the detector runs on the frame's brightest-percentile luma rather than the average — the lit LED sits near clipping, so exposure changes to the background barely move it (the signal meter still shows average brightness). Second, an edge needs the luma to stay across the threshold for about two camera frames (the debounce adapts to the measured frame rate, and 60 fps is requested when the camera offers it), so a blink's on-time must span roughly three frames to measure: about 50 ms at 60 fps, about 100 ms at 30 fps. Faster speeds show a "changing faster than the camera can see" hint instead of a measurement; slow speeds are covered by the per-row timeout, which extends automatically to fit the measured rate.

Important: opening `http://192.168.x.x:4173/` from the phone is not a secure context, so Bluetooth will be unavailable. For USB-local debugging, enable Android USB debugging and run `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/` on the phone. Otherwise use an HTTPS tunnel or HTTPS hosting.

For a quick local preview from the repository root:

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory web
```

Then open `http://127.0.0.1:4173/`.

Run the show-format tests from `web` with:

```powershell
npm test
```
