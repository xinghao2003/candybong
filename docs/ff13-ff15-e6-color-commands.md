# `FF 13`, `FF 14`, `FF 15`, `FF E6`, and `FF E7` Color Commands

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
FF 14 00 AnimationId Speed
FF 15 00 PaletteIndex
FF E6 00 R G B Brightness
FF E7 Speed Hue
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

### Inner and outer ring behavior

The hardware has 12 outer RGBW LEDs and 10 inner RGBW LEDs. The firmware uses
positions `0..0x0b` for the outer ring and `0x0c..0x15` for the inner ring.

The low-level routines can address the rings separately:

| Function | Positions |
|---|---|
| `set_only_led_ring_color()` at `0x26e1c` | Outer ring `0..0x0b` |
| `set_led_inner_ring()` at `0x26ee2` | Inner ring `0x0c..0x15` |

However, `FF E6` carries only one RGB color. Its normal BLE path writes one
shared RGBW state and calls `set_led_group_color()`. It cannot specify one
arbitrary color for the outer ring and another arbitrary color for the inner
ring in the same packet.

The group state can select one ring at a time, so firmware callers can set one
ring and then the other. The known BLE command list does not expose a separate
outer-color/inner-color packet. Some preset and animation routines do write
different values to both rings, but those colors are firmware-defined.

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

### Entering mode `0x65`

The BLE `FF 14` handler maps animation ID `9` to the internal preset:

```text
FF 14 00 09 Speed
    -> set_led_preset(0x65)
```

The `Speed` byte is not used by this ID-`9` branch, so a practical packet is:

```text
FF 14 00 09 00
```

This path sets the shared brightness byte to `3`, writes the `0x65` preset,
and clears the active timer flag. To enter the preset and then adjust its
scaling, send for example:

```text
FF 14 00 09 00    # select the internal 0x65/Twice preset
FF 13 00 0A       # reapply it with scaling value 10
```

The second packet is optional; it changes the preset's shared scaling value.
The `0x65` mode marker is written by `set_led_preset(0x65)` to the current
mode state at approximately `0x20006799`.

## `FF 14`: Built-in animations

The packet is:

```text
FF 14 00 AnimationId Speed
```

The handler reads `AnimationId` from packet byte `3` and initially sets the
shared scaling byte to `3`. ID `6` changes that initial scaling to `5`. The
animation is then dispatched through the firmware timer and one of several
internal state machines:

| ID | Internal path | What it does | Effective speed behavior |
|---:|---|---|---|
| `01` | opcode `0x15`, animation type `9` | Fades through a five-entry RGBW table at `0x20002d18`, then wraps | Uses the supplied `Speed` byte |
| `02` | opcode `0x16`, animation type `3` | Fades through a 20-entry RGB table at `0x20002db8`; per-entry durations come from `0x20002d2c` | Supplied speed is overwritten with `5` |
| `03` | opcode `0` | Turns the selected LED group off | Speed ignored |
| `04` | opcode `0x17`, animation type `4` | Chooses a firmware color pseudo-randomly and fades toward it | Supplied speed is overwritten with `16` |
| `05` | opcode `0x10`, animation type `0` | Alternates/fades between red-orange `FF 0A 14` and orange `FF 50 00` | Uses the supplied `Speed` byte |
| `06` | opcode `0x18`, animation type `2` | Fades through a seven-entry RGB table at `0x20002d7c`, then wraps | Uses `Speed + 9`; scaling starts at `5` |
| `07` | opcode `0xb1` -> preset `0xb` | Clears LED positions `0..0x17`; the scheduled preset callback is a no-op | Speed ignored; internal timer value is `7` |
| `08` | opcode `0xb2` -> preset `0xc` | Writes a fixed multicolor segment pattern; the scheduled preset callback is a no-op | Speed ignored; internal timer value is `0x1e` |
| `09` | direct preset `0x65` | Applies the static Twice/`0x65` pattern and stops the timer | Speed ignored |

For the real interpolation engines, the timer conversion is approximately:

```text
Q(v) = floor((v * 32768 + 1000) / 2000) RTC ticks
T_callback = Q(v) / 16384 seconds ≈ v milliseconds
```

The first timer kick for this command family is approximately 10 ms because
the handler selects timer state `3`; after that, the callback restarts using
the effective speed listed above. The FF14 handler does not clamp IDs `1` and
`5`, so `Speed = 0` produces a zero timer value in the decompiled formula and
should be avoided. IDs `2`, `4`, and `6` apply their internal overrides before
the repeated timer is restarted.

### ID `01`: five-entry color fade

`led_prepare_state_opcode(0x15)` initializes animation type `9` with a
15-step interpolation and a five-entry cycle count. The callback in
`FUN_00028650` reads four-byte RGBW entries from `0x20002d18`, interpolates
between the current and next entry, and advances the table index after each
transition. The table values are firmware data, not generated from HSV.

### ID `02`: 20-entry timed color cycle

`led_prepare_state_opcode(0x16)` calls `FUN_00039ca4(0)`. That routine reads
the current and next RGB values from the 20-entry table at `0x20002db8` and a
halfword duration from `0x20002d2c`. `FUN_00038fd0` performs the channel
interpolation and advances the index modulo 20. Although the packet contains
a speed byte, the opcode setup overwrites the timer speed with `5`, so changing
the fifth packet byte is not expected to change this animation's cadence.

### ID `03`: off

This branch schedules opcode `0`. The timer dispatcher sends zero RGBW to the
selected group. The packet's speed byte is never copied into the shared speed
state.

### ID `04`: random-color fade

`led_prepare_state_opcode(0x17)` clears the current RGB state, fixes the timer
speed at `0x10`, and calls `FUN_00039b54(0)`. The helper chooses a random
transition offset from `0..11`, then makes a weighted random selection among
four firmware color entries at `0x20002d98`. The generic transition engine
fades toward the selected color. This is random selection from firmware data,
not a random RGB value generated over the full 24-bit RGB cube.

### ID `05`: orange/red-orange alternation

`led_prepare_state_opcode(0x10)` initializes animation type `0` with two
states and 15 interpolation steps. The callback alternates these fixed RGB
targets:

```text
state 0: FF 0A 14  // red-orange
state 1: FF 50 00  // orange
```

The supplied speed controls callback cadence, while the 15-step state machine
controls how many callbacks are used for each fade. This is a brightness/fade
animation between two fixed colors, not a hue-wheel animation.

### ID `06`: seven-color fade

`led_prepare_state_opcode(0x18)` calls `FUN_00039c58(0x32, 0)`. The helper
selects the current and next entries from the seven-entry RGB table at
`0x20002d7c` and requests a 50-step transition. The index wraps after entry
`6`. The handler's scaling byte is `5`, and the timer speed becomes the packet
value plus `9`; for example, `Speed = 16` gives an effective timer value of
`25` (approximately 25 ms per callback).

### IDs `07` and `08`: static built-in patterns

ID `7` explicitly writes zero RGBW to positions `0..0x17`. It then schedules
preset `0xb`; in this firmware build, `set_led_preset()` returns immediately
for preset values `0xb` through `0xf`, so no visible frame animation follows.

ID `8` writes a fixed pattern using code `0x4b` (`3 * 25`) before scheduling
preset `0xc`, which is likewise a no-op in the preset function:

| Positions | Raw RGB code |
|---|---|
| `0..5` | `4B 00 00` red |
| `6` | `00 4B 00` green |
| `7..8` | off |
| `9..0xb` | `00 4B 00` green |
| `0xc..0x11` | `00 00 4B` blue |
| `0x12` | `4B 4B 00` yellow |
| `0x13..0x14` | off |
| `0x15..0x17` | `4B 4B 00` yellow |

The normal ring map ends at position `0x15`, but this branch writes through
`0x17`; those extra positions are part of the firmware's LED buffer path and
should be treated as a device-specific quirk.

### ID `09`: Twice/`0x65` preset

This branch sets the shared scaling byte to `3`, applies preset `0x65`, and
clears the active timer flag. It is the same static preset described in the
`FF 13` section, not a looping animation. A practical packet is:

```text
FF 14 00 09 00
```

The final byte is accepted but ignored by this branch.

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

## `FF E7`: Rotate the built-in color pattern

The BLE handler interprets the packet as:

```text
FF E7 Speed Hue
```

It stores `Hue` in the shared state byte used by `set_led_color()`:

```text
color_state[4] = Hue
```

The firmware does not convert this byte through an HSV hue formula or a color
lookup table. In this path, `Hue` is effectively the scaling value applied to
the fixed colors used by the animation. For example, the animation repeatedly
uses:

```text
orange       RGB FF 50 00
red-orange   RGB FF 0A 14
inner white  W   FF
```

The fixed pattern is moved around the outer ring. The animation routine writes
different subsets of outer positions `0..0x0b` with the two RGB colors, then
advances or decrements an internal frame index. The inner positions
`0x0c..0x15` are written as white or off according to the group state. Thus
“rotate” refers primarily to spatial movement around the outer ring, not hue
rotation through the RGB color wheel.

The speed mapping is:

| Packet speed | Internal state | Behavior |
|---:|---:|---|
| `0` | `0x79` | Apply one `0x65`/Twice preset frame; no rotating frame loop |
| `1` | `0x7b` | Rotate; approximately 250 ms per outer-ring step |
| `2` | `0x7c` | Rotate; approximately 150 ms per step |
| `3` | `0x7d` | Rotate; approximately 100 ms per step |

The rotating states use a roughly 10 ms timer callback. The first speed-3
step can be slightly shorter during initialization. Direction is controlled
by internal state, not by a field in the `FF E7` packet.

Because `Hue` is fed into the scaling formula, values around `0..10` behave
most like ordinary brightness values. Larger byte values can produce the
non-linear bit-plane behavior described below. For example, `FF E7 01 0A`
means speed `1` with scaling `10`; it does not mean HSV hue `10` degrees.

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
| `0x35dc0` | `ble_nus_data_handler` | Parses `FF 13`, `FF 14`, `FF 15`, `FF E6`, and `FF E7` |
| `0x2000876e` | Shared color state | RGBW codes and brightness byte |
| `0x26e1c` | `set_only_led_ring_color` | Writes the outer ring |
| `0x26ee2` | `set_led_inner_ring` | Writes the inner ring |
| `0x27038` | `set_led_group_color` | Applies a color to LED groups/positions |
| `0x316f0` | `set_led_color` | RGBW conversion, quantization, bit-plane output |
| `0x2b184` | `rf_timer_event_handler` | Dispatches scheduled LED commands |
| `0x28fa8` | `led_prepare_state_opcode` | Maps FF14 IDs to internal animation states |
| `0x28650` | Table/preset interpolation engine | Drives FF14 IDs `1` and `5` |
| `0x38fd0` | RGB transition engine | Drives FF14 IDs `2`, `4`, and `6` |
| `0x39b54` | Random-color setup | FF14 ID `4` color selection |
| `0x39c58` | Seven-entry table setup | FF14 ID `6` color cycle |
| `0x39ca4` | 20-entry table setup | FF14 ID `2` color cycle |
| `0x3a06c` | Two-state animation setup | FF14 ID `5` orange alternation |
| `0x2b800` | `do_led_preset_x65` | Applies one `0x65` preset frame |
| `0x2b808` | Rotating preset callback | Moves the fixed pattern around the outer ring |
| `0x2987c` | `set_led_preset` | Includes the `0x65` Twice pattern |
| `0x39f60` | E7 animation setup | Initializes speed-dependent rotation state |

This document is based on static Ghidra decompilation. Runtime capture or
photometric measurement would still be required to validate timing, driver
polarity, and the physical appearance of each code.
