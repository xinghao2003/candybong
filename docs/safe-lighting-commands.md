# Safe lighting and animation commands

This is the practical allow-list for experimenting with the Candybong Infinity
LEDs. It is intentionally narrower than the full
[Bluetooth command reference](bluetooth-command-reference.md).

“Safe” here means that static firmware tracing shows a direct LED/color path
and no configuration write, DFU transition, or unexplained bridge operation.
It is not a guarantee against firmware bugs or hardware damage.

## Recommended allow-list

Use only these commands when the goal is to experiment with light output:

| Command | Packet format | Safe values | Visible behavior |
|---|---|---|---|
| `FF 11` | `FF 11` | None | Turns LEDs on or restores the previous shared color |
| `FF 12` | `FF 12` | None | Turns the selected LED group off |
| `FF 13` | `FF 13 00 Value` | `Value = 0..10` for normal scaling | Adjusts the brightness/scaling of the current color or `0x65` preset |
| `FF 14` | `FF 14 00 Id Speed` | `Id = 1..9`; use nonzero `Speed` | Selects a known built-in animation, off path, static pattern, or `0x65` preset |
| `FF 15` | `FF 15 00 PaletteIndex` | `PaletteIndex = 0..0x1B` | Selects one of 28 built-in solid colors |
| `FF E1` | `FF E1 00 R G B Speed` | RGB `0..255`; speed normally `2..100` | Blinks one RGB color |
| `FF E2` | `FF E2 00 R G B Speed` | RGB `0..255`; speed normally `2..100` | Fades between black and the selected color |
| `FF E3` | `FF E3 00 R G B Speed` | RGB `0..255`; speed normally `2..100` | Fades between approximately 20% and full color |
| `FF E4` | `FF E4 00 00 00 00 Speed` | Speed normally `2..100` | Cycles through the firmware random-color table |
| `FF E6` | `FF E6 00 R G B Brightness` | RGB `0..255`; brightness `0..10` | Sets a direct RGB solid color |
| `FF E7` | `FF E7 Speed Hue` | Speed `0..3`; use Hue `0..10` | Rotates the fixed built-in orange/red-orange pattern |

The detailed behavior and internal mechanisms are documented in:

- [FF13/FF14/FF15/FFE6/FFE7 color commands](ff13-ff15-e6-color-commands.md)
- [FF E1 blink](e1-blink-animation.md)
- [FF E2/FF E3/FF E4 animations](e2-e3-e4-animations.md)

## FF14 animation IDs considered safe

All nine IDs are in the allow-list because their traced paths write only LED
state or a built-in LED preset. They are not all continuously animated:

| Packet example | Result | Speed note |
|---|---|---|
| `FF 14 00 01 10` | Five-entry RGBW fade cycle | Uses supplied speed |
| `FF 14 00 02 10` | Twenty-entry color cycle | Firmware forces speed to `5` |
| `FF 14 00 03 00` | Off | Speed ignored |
| `FF 14 00 04 10` | Random firmware-color fade | Firmware forces speed to `16` |
| `FF 14 00 05 10` | Orange/red-orange fade | Uses supplied speed |
| `FF 14 00 06 10` | Seven-color fade cycle | Effective speed is `Speed + 9` |
| `FF 14 00 07 00` | Static all-off pattern | Speed ignored |
| `FF 14 00 08 00` | Static multicolor segment pattern | Speed ignored |
| `FF 14 00 09 00` | Static Twice/`0x65` preset | Speed ignored |

For IDs `1` and `5`, do not use `Speed = 0`; the raw firmware timer formula
can produce a zero timer interval. A starting value around `10..30` is a
reasonable experiment. ID `6` adds `9` internally, while IDs `2` and `4`
override the supplied value.

## Suggested test sequence

Start and stop experiments with direct, low-risk packets:

```text
FF 12                         # stop/clear the selected group
FF E6 00 FF 00 00 0A          # full red, normal brightness
FF E6 00 00 00 FF 05          # blue, lower brightness
FF 15 00 0F                   # built-in cyan palette entry
FF 14 00 01 10                # start a known fade cycle
FF 12                         # stop the animation
FF E7 01 0A                   # rotate fixed pattern at speed 1
FF 12                         # stop again
```

The commands use shared LED state. Starting a new animation generally replaces
the previous timer state; sending `FF 12` first makes the test boundary clear.
The normal BLE path also applies the current LED-group selection, so a command
may affect the outer ring, inner ring, or both depending on the existing group
state.

## Excluded from lighting experiments

Do not use these commands as part of ordinary LED tinkering yet:

| Commands | Why excluded |
|---|---|
| `FF C1`, `C3`, `C5`, `C6`, `C7`, `C8`, `C9`, `CA` | Configuration/readback relay paths; some branches write internal configuration bytes |
| `FF AD` | Unexplained subcommand bridge; forwards controller data |
| `FF 16`, `FF 18`, `FF 1A`, `FF 21` | Measurement, timing, or bridge/status operations rather than direct LED commands |
| `FF A0`, `A1`, `A3`, `A5`, `A9`, `AA`, `AB`, `AC`, `AE`, `AF` | A* frame protocol. It appears RAM-backed and non-persistent, but upload lengths, target selector, playback semantics, and scheduler fields are not safe to guess; see the detailed A* analysis in the [command reference](bluetooth-command-reference.md#a-frame-and-animation-streaming-commands) |
| `FF E5` | Changes an internal scaling field without a traced refresh/output operation |
| `FF E9` | Echo/checksum diagnostic path; not a lighting command |
| `FF EB`, `FF ED` | Unresolved frame/control requests |
| `@dfu` | Requests a reset into DFU mode; explicitly outside lighting experiments |

The `A*` commands may eventually prove to be the most interesting way to
upload custom animations, but they should be treated as an experimental second
phase after capturing a known-good client exchange and determining the frame
buffer format.
