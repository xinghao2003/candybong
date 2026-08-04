# `FF E1` Blink Animation

This document describes the fundamental behavior of the Candybong Infinity
firmware's BLE `FF E1` blink command.

The analysis is based on the firmware image
`firmware/twice/nordic_tw3_230206_V1_3_RF447_9_OTA` and its Ghidra database
`ghidra_db/nordic_tw3_230206_V1_3_RF447_9_OTA.gzf`.

## Command format

```text
FF E1 00 R G B Speed
```

`R`, `G`, and `B` are the color to display. The firmware alternates between
that color and black. `Speed` is an unsigned byte, but it is not a frequency
or a delay in the direct sense. A larger value produces slower blinking.

## Animation state machine

The animation has two levels of timing:

1. A repeated RTC timer invokes the animation callback.
2. The blink routine counts timer callbacks and only changes the LED after a
   number of callbacks equal to the normalized speed.

On each blink transition, the firmware does one of the following:

```text
colored(R, G, B) -> black
black            -> colored(R, G, B)
```

The on and off durations are equal in steady state, so the animation is
approximately 50% duty cycle.

The relevant reverse-engineered path is:

```text
BLE handler 0x35dc0
    -> LED command opcode 0xC8 (decimal 200)
    -> state preparation 0x28fa8
    -> timer setup 0x3a300
    -> timer callback 0x2b184
    -> blink routine 0x2f63c
```

The E1 path dispatches the blink routine through animation state `0x89`.
The blink routine increments a callback counter. When the counter reaches the
stored threshold, it resets the counter and toggles between the selected RGB
color and black.

## Speed normalization

Let `s` be the byte supplied in the command and `u` be the value used by the
animation:

```text
if s < 95:
    u = s + 5
else:
    u = s

if u >= 100:
    u = 100
```

For legal byte inputs, the effective mapping is therefore:

```text
s = 0..94   -> u = min(s + 5, 100)
s = 95..255 -> u = min(s, 100)
```

There is a small discontinuity at the boundary:

```text
s = 94 -> u = 99
s = 95 -> u = 95
```

The lower clamp present in the disassembly does not affect ordinary unsigned
byte inputs on this E1 path, because the `s < 95` branch already adds five.

## Timer interval

The firmware initializes the RTC timer with prescaler `1`, giving an RTC rate
of:

```text
32768 Hz / (1 + 1) = 16384 ticks/second
```

The steady-state timer interval is calculated as:

```text
q = floor((u * 32768 + 1000) / 2000) RTC ticks
```

The interval between timer callbacks is therefore:

```text
T_callback = q / 16384 seconds
```

Since `q` is approximately `u * 16.384`, this is approximately `u`
milliseconds.

The first E1 timer is started with a temporary 10 ms interval. After the first
callback, the timer is restarted using the speed-dependent interval above.

## Blink period and frequency

The blink routine waits for `u` timer callbacks before each LED transition.
Consequently, the time for one transition is:

```text
T_toggle = u * q / 16384 seconds
```

A complete blink cycle consists of one colored interval and one black
interval:

```text
T_cycle = 2 * u * q / 16384 seconds
```

The complete on/off cycle frequency is:

```text
f_cycle = 16384 / (2 * u * q) Hz
```

Using the approximation `q ≈ u * 16.384`:

```text
T_cycle ≈ 2 * u² milliseconds
f_cycle ≈ 500 / u² Hz
```

This is the important result: the speed value affects both the timer interval
and the number of callbacks required for a transition. The resulting blink
period is approximately quadratic in the normalized speed.

If frequency is instead defined as the number of LED state changes per second,
that value is twice the complete-cycle frequency:

```text
f_transition = 16384 / (u * q) = 2 * f_cycle
```

## Reference values

The table uses the exact integer timer calculation above. The frequency is the
frequency of a complete colored-to-black-to-colored cycle.

| Supplied `s` | Normalized `u` | Timer `q` (ticks) | Time per transition | Full cycle | Full-cycle frequency |
|---:|---:|---:|---:|---:|---:|
| 0 | 5 | 82 | 25.024 ms | 50.049 ms | 19.98 Hz |
| 5 | 10 | 164 | 100.098 ms | 200.195 ms | 5.00 Hz |
| 10 | 15 | 246 | 225.220 ms | 450.439 ms | 2.22 Hz |
| 16 | 21 | 344 | 440.918 ms | 881.836 ms | 1.13 Hz |
| 20 | 25 | 410 | 625.610 ms | 1.251 s | 0.799 Hz |
| 50 | 55 | 901 | 3.025 s | 6.049 s | 0.165 Hz |
| 100 | 100 | 1638 | 9.998 s | 19.995 s | 0.0500 Hz |
| 255 | 100 | 1638 | 9.998 s | 19.995 s | 0.0500 Hz |

For example, a command whose final byte is decimal `16` uses `u = 21` and
blinks with a complete cycle of approximately `882 ms`.

## Scope and caveats

- This formula applies to the simple RGB blink command `FF E1`.
- `FF E2` and `FF E3` use the speed-dependent timer but execute fade state
  machines, so their visible animation cycle is not described by this blink
  equation.
- `FF E4` uses a random-color animation routine and likewise has different
  visible behavior.
- `FF 14` animation presets dispatch to separate animation routines and should
  not be assumed to use the E1 formula.
- The first transition after a command can depend on the prior animation
  counter and LED state. The period described above is the steady-state period.
- The calculation is static firmware analysis. Bluetooth processing latency,
  LED-driver work, and callback scheduling can add small runtime deviations.

## Firmware evidence

| Firmware function | Role |
|---|---|
| `0x35dc0` | BLE packet parser and E1 speed/color extraction |
| `0x28fa8` | Copies normalized speed into the blink state threshold |
| `0x3a300` | Starts the repeated animation timer |
| `0x2b184` | Reprograms the timer and dispatches animation callbacks |
| `0x2f63c` | Counts callbacks and toggles RGB/black |
| `0x2df94` | Initializes the app timer and RTC configuration |
