# `FF 13`, `FF 15`, and `FF E6` Color Commands

This document records the static reverse engineering of the Candybong Infinity
BLE color commands in firmware image
`firmware/twice/nordic_tw3_230206_V1_3_RF447_9_OTA`.

The analysis uses the Ghidra database
`ghidra_db/nordic_tw3_230206_V1_3_RF447_9_OTA.gzf`. It describes firmware
behavior and LED-driver codes; it does not establish the final optical color
produced by a particular physical LED, diffuser, or light stick.

## Command formats

The BLE command parser is at firmware address `0x35dc0`,
`ble_nus_data_handler()`.

```text
FF 13 00 Value
FF 15 00 PaletteIndex
FF E6 00 R G B Brightness
```

The Android proof-of-concept uses `Value = 0..255` for `FF 13` and
`Brightness = 0..10` for `FF E6`.

## Shared color state and output path

The firmware uses a shared color state beginning at RAM address approximately
`0x2000876e`:

| Offset | Meaning |
|---:|---|
| `+0` | Red input/code |
| `+1` | Green input/code |
| `+2` | Blue input/code |
| `+3` | White input/code |
| `+4` | Brightness/scaling byte |
| `+0x16` | Auxiliary speed/state used by some command paths |
| `+0x1c` | Command/animation state flag |

The normal solid-color refresh path is:

```text
BLE handler 0x35dc0
    -> schedule LED command opcode 1
    -> timer/LED dispatcher 0x2b184
    -> set_led_group_color 0x27038
    -> set_led_color 0x316f0
    -> LED-driver bit-plane buffer
```

`set_led_group_color()` applies one RGBW code to selected physical LED
positions. There are 22 positions in the firmware, numbered `0` through
`0x15`.

The group selector changes which positions receive the color:

| Group state | Positions affected by `set_led_group_color()` |
|---:|---|
| `2` | Outer positions `0..0x0b`; inner positions `0x0c..0x15` are cleared |
| `3` | Outer positions are cleared; inner positions `0x0c..0x15` receive the color |
| `4` | Outer positions `0..0x0b` receive the color |
| `5` | Inner positions `0x0c..0x15` receive the color |
| Other | All positions `0..0x15` receive the color |

Consequently, “solid color” means solid across the selected LED group, not
necessarily every LED on the device.

## `FF 13`: Twice adjustment

The handler stores `Value` in the shared brightness/scaling byte:

```text
color_state[4] = Value
```

If the current mode is not `0x65`, the handler schedules the normal solid
refresh path. If the current mode is `0x65`, it calls:

```text
set_led_preset(0x65)
```

and clears the active timer flag for this command path.

Preset `0x65` writes a fixed multi-position pattern. Depending on the group
state, the pattern contains combinations of:

```text
orange       RGB FF 50 00
red-orange   RGB FF 0A 14
white        W   FF
off          RGB/W 00
```

The `FF 13` value is then applied by `set_led_color()` to those fixed colors.
The packet itself does not contain a hue-wheel algorithm or a frame counter.
In the `0x65` path, it re-emits a preset frame and clears the timer flag. Any
animation observed while changing this value is therefore likely caused by
repeated host commands or another animation state, rather than by `FF 13`
advancing frames internally.

Although the Android client calls this a color shift, the firmware uses the
value as an 8-bit scaling byte. Values above the normal `0..10` brightness
range are not linear brightness percentages and can produce non-linear color
changes after bit-plane encoding.

## `FF 15`: Built-in solid-color palette

The handler switches on `PaletteIndex` and writes one of 28 RGB constants into
the shared color state. It then sets:

```text
color_state[4] = 8
```

and schedules the normal solid refresh path. It is a palette selector, not an
arbitrary RGB command and not an animation command.

| Index | RGB code |
|---:|---|
| `00` | `FF FF FF` |
| `01` | `FF 00 00` |
| `02` | `FF 5B 00` |
| `03` | `FF FF 00` |
| `04` | `FF C8 00` |
| `05` | `FF F8 00` |
| `06` | `E0 FF 00` |
| `07` | `A8 FF 00` |
| `08` | `7D FF 00` |
| `09` | `3F FF 00` |
| `0A` | `00 FF 00` |
| `0B` | `00 FF 30` |
| `0C` | `00 FF 73` |
| `0D` | `00 FF A3` |
| `0E` | `00 FF E0` |
| `0F` | `00 FF FF` |
| `10` | `00 C9 FF` |
| `11` | `00 92 FF` |
| `12` | `00 62 FF` |
| `13` | `00 4F FF` |
| `14` | `00 00 FF` |
| `15` | `44 00 FF` |
| `16` | `6F 00 FF` |
| `17` | `A7 00 FF` |
| `18` | `E6 00 FF` |
| `19` | `FF 00 F3` |
| `1A` | `FF 00 FB` |
| `1B` | `FF 00 86` |

The palette is a vendor-selected color wheel. Its points are not evenly
spaced in RGB or HSV space. The RGB values also pass through the normal
RGBW conversion and quantization described below.

## `FF E6`: Direct RGB solid color

The handler writes the packet fields as follows:

```text
color_state[0] = packet[3]   // R
color_state[1] = packet[4]   // G
color_state[2] = packet[5]   // B
color_state[4] = packet[6]   // Brightness
```

It selects the direct solid-color state and schedules LED command opcode `1`.
It does not select a palette entry or start a hue animation.

The handler also reads `packet[7]` into auxiliary speed/state. That byte is
outside the documented seven-byte form `FF E6 00 R G B Brightness`. It does
not appear to affect the direct solid-color output, but is a firmware/protocol
quirk worth remembering when constructing packets.

## RGB/RGBW quantization algorithm

The main output routine is `set_led_color()` at `0x316f0`. Before writing the
LED-driver bit planes, it performs this approximate conversion:

```c
if (r == g && g == b && r != 0) {
    // Equal nonzero RGB is treated as white.
    w = r;
    r = 0;
    g = 0;
    b = 0;
}

if ((r != 0 || g != 0 || b != 0) && w != 0) {
    // RGB takes priority over white when both are supplied.
    w = 0;
}

r_out = brightness * (r / 10);
g_out = brightness * (g / 10);
b_out = brightness * (b / 10);
w_out = brightness * (w / 10);
```

The division is integer division. Each input channel is therefore grouped
into 26 buckets:

```text
0..9       -> 0
10..19     -> 1
20..29     -> 2
...
250..255   -> 25
```

For example, at brightness `10`:

```text
input 255 -> output 10 * floor(255 / 10) = 250
input 128 -> output 10 * floor(128 / 10) = 120
input 9   -> output 10 * floor(9 / 10)   = 0
```

At brightness `8`, the output levels are `0, 8, 16, ..., 200`. The output
values are then emitted as 8-bit bit planes to the LED-driver buffer.

For the intended `FF E6` brightness range `0..10`, the direct RGB path has at
most 26 effective levels per channel before the RGB-to-white rule. Thus a
fixed brightness has at most:

```text
26 * 26 * 26 = 17,576
```

RGB code combinations, rather than all `256 * 256 * 256` exact input values.
The firmware still covers the broad red/green/blue/cyan/yellow/magenta
regions; it just does so with coarse channel steps.

Brightness values above `10` are not clamped by the `FF E6` handler. The
bit-plane tests consume the low 8 bits of the scaled result, so out-of-range
brightness values can wrap or alias instead of behaving as normal dimming.

## What is and is not mapped by the firmware

The firmware maps command RGB values to:

1. RGB or white channel selection;
2. quantized/scaled channel codes;
3. bit-plane data for the LED driver; and
4. selected physical LED positions.

The firmware does not contain evidence of optical calibration, gamma lookup,
color-temperature correction, or a CIE/HSV-to-LED conversion. Therefore the
RGB values in the packet should be treated as device-specific LED-driver
codes. The exact visible color still depends on the LED package, current
driver, diffuser, and individual hardware.

## Firmware evidence

| Address | Function or data | Role |
|---:|---|---|
| `0x35dc0` | `ble_nus_data_handler` | Parses `FF 13`, `FF 15`, and `FF E6` |
| `0x2000876e` | Shared color state | RGBW codes and brightness byte |
| `0x27038` | `set_led_group_color` | Applies a color to LED groups/positions |
| `0x316f0` | `set_led_color` | RGBW conversion, quantization, bit-plane output |
| `0x2b184` | `rf_timer_event_handler` | Dispatches scheduled LED commands |
| `0x2987c` | `set_led_preset` | Includes the `0x65` Twice pattern |

This document is based on static Ghidra decompilation. Runtime capture or
photometric measurement would still be required to validate timing, driver
polarity, and the physical appearance of each code.
