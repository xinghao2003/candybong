# `FF E2`, `FF E3`, and `FF E4` Animations

This document describes the animation routines used by the other BLE color
commands related to `FF E1`.

The common timer conversion is:

```text
Q(v) = floor((v * 32768 + 1000) / 2000) RTC ticks
T_callback(v) = Q(v) / 16384 seconds
```

The RTC runs at 16,384 ticks/second because the firmware uses an RTC prescaler
of `1`. The important difference between commands is how many callbacks their
animation routine consumes before changing the visible output.

## `FF E2`: fade from black to full color

### Command format

```text
FF E2 00 R G B Speed
```

The BLE handler normalizes the supplied speed `s` as:

```text
u = max(2, min(s, 100))
```

When the E2 state is prepared, the firmware adds `2` to that value for the
animation timer:

```text
v_E2 = u + 2
```

The fade routine then performs a 100-callback interpolation in each direction:

```text
black -> (R, G, B) -> black
```

Therefore, one complete fade cycle is approximately:

```text
T_E2 = 200 * Q(v_E2) / 16384 seconds
f_E2 = 16384 / (200 * Q(v_E2)) Hz
```

The `+2` adjustment means this is not exactly the same timer pace as E1 for a
given supplied speed. The first transition can also depend on the previous
animation state.

## `FF E3`: fade between 20% and full color

### Command format

```text
FF E3 00 R G B Speed
```

E3 uses the same input normalization as E2:

```text
u = max(2, min(s, 100))
```

Its state preparation adds `9` to the normalized value:

```text
v_E3 = u + 9
```

The fade setup scales the low endpoint to 20% of the supplied RGB color:

```text
20% * (R, G, B) -> (R, G, B) -> 20% * (R, G, B)
```

It also uses 100 callbacks for each direction, so:

```text
T_E3 = 200 * Q(v_E3) / 16384 seconds
f_E3 = 16384 / (200 * Q(v_E3)) Hz
```

E3 is slower than E2 at the same supplied speed because its timer value is
`u + 9` instead of `u + 2`. Unlike E2, it does not fade all the way to black.

## `FF E4`: table-driven random-color blink

### Command format

```text
FF E4 00 00 00 00 Speed
```

The RGB bytes are ignored by this animation. The firmware normalizes speed in
the same way as E1:

```text
w = s < 95 ? s + 5 : s
w = min(w, 100)
```

The E4 state machine is initialized with three callback slots for each phase:

```text
selected color: 3 callbacks
off:            3 callbacks
next color:     select another table entry
```

Thus one color/off cycle is:

```text
T_E4 = 6 * Q(w) / 16384 seconds
f_E4 = 16384 / (6 * Q(w)) Hz
```

The color is selected from a firmware-managed color table using a 28-step
lookup sequence. The sequence wraps after 28 entries. It behaves as a random
color animation from the protocol's perspective, but the callback routine
does not generate a new random RGB value on every callback.

## Comparison at the same supplied speed

The following values use the exact integer timer calculation and a complete
cycle definition:

| Command | Supplied speed | Timer value | Visible behavior | Full-cycle period |
|---|---:|---:|---|---:|
| E1 | 16 | `u = 21` | 21 callbacks per transition | 881.8 ms |
| E2 | 16 | `v = 18` | 100-step black/color fade | 3.601 s |
| E3 | 16 | `v = 25` | 100-step 20%/full fade | 5.005 s |
| E4 | 16 | `w = 21` | 3 callbacks on, 3 callbacks off | 126.0 ms |

So the commands do not share one visible blink frequency:

- E1 has a quadratic speed relationship because speed controls both timer
  interval and callback count.
- E2 and E3 have roughly linear speed relationships because their callback
  count is fixed at 100 steps per fade direction.
- E4 has roughly a linear speed relationship because its cycle is fixed at six
  callbacks.

## Firmware paths

| Command | BLE opcode dispatched | Timer callback path | Animation routine |
|---|---:|---|---|
| E2 | `0x02` | `0x2b184` case 2 | `0x38fd0` |
| E3 | `0x03` | `0x2b184` case 3 | `0x38fd0` |
| E4 | `0x0c` | `0x2b184` case `0x0c` | `0x28650` |
