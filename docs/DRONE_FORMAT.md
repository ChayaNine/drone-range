# Drone file format

A drone is one small JSON file. Drone Range reads two shapes:

| Shape | Use it when |
| --- | --- |
| **Recipe** | You are writing a drone by hand. Give a name, an airframe, a size and a loadout. Motors, battery and balance are worked out for you. |
| **Full spec** | You exported the drone from Drone Surrogate Factory, or you want to control every number yourself. |

Both can be dropped into [`src/drones/`](../src/drones) (it then appears in the picker), dragged onto the start screen, or pasted into **Add a drone**. Files you add in the browser live in that browser only.

Check any file before you share it:

```bash
npm run drone:check -- path/to/my-drone.json
```

It prints what the simulator will make of the drone (mass, top speed, endurance, thrust-to-weight) and, if something is wrong, says exactly which field to fix.

## Recipe

The smallest drone that flies:

```json
{
  "name": "Starter Quad",
  "layout": "quad_x",
  "length": 0.45
}
```

A fully dressed one:

```json
{
  "format": "drone-range/recipe/1",
  "name": "Warden Hexa",
  "layout": "hexa_x",
  "length": 1.1,
  "weapons": [{ "id": "kinetic", "mount": "belly" }, { "id": "missile", "mount": "left" }],
  "systems": [{ "id": "radar", "mount": "top" }, { "id": "smoke", "mount": "tail" }],
  "avionics": "mil",
  "frameMaterial": "ti_carbon",
  "livery": { "primary": "#3b4248", "secondary": "#23282d", "accent": "#ffb347", "finish": "matte", "pattern": "digital" },
  "notes": "Shown on the drone's card."
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Shown in the picker. Up to 60 characters. |
| `layout` | yes | The airframe. See [Airframes](#airframes). |
| `length` | yes | Metres. For multirotors, rotor tip to rotor tip. For aeroplanes, nose to tail. |
| `width` | no | Metres. Defaults to `length`. For aeroplanes this is the **wingspan**. |
| `weapons` | no | Up to **2**. Each is an id (`"kinetic"`) or `{ "id": "kinetic", "mount": "belly" }`. |
| `systems` | no | Up to **2**. Same shape as weapons. |
| `body` | no | Any of `shape`, `gear`, `tail`, `thrust`, `gpsMast`, `antennas`, `gimbal`. See [Values](#values). |
| `livery` | no | Any of `primary`, `secondary`, `accent` (hex colours), `finish`, `pattern`. |
| `avionics` | no | `hobby`, `pro` or `mil`. Better avionics tilt harder and aim more accurately, but weigh more. |
| `frameMaterial` | no | `polymer`, `carbon`, `aluminium` or `ti_carbon`. |
| `propMaterial` | no | `plastic` or `carbon`. |
| `chemistry` | no | `lipo`, `liion`, `solid` or `hydrogen`. Leave it out and the sizer picks one. |
| `notes` | no | A line of text shown under the stats. |
| `format` | no | `"drone-range/recipe/1"`. Optional; a file with `layout` and `length` and no `version` is read as a recipe. |

**What the loader works out for you.** It picks the motor class and cell count that give a healthy thrust-to-weight on your airframe's propellers, sizes the battery to a sensible share of takeoff mass *after* adding your loadout, and slides the battery to centre the balance. That is why a drone with a heavy turret gets bigger motors and a bigger pack than the same airframe without one.

**Mounts.** Each weapon and system only fits certain mounts (the tables below). If you leave `mount` out, the first free one is used. Two modules cannot share a mount; the stealth skin is the one exception.

## Full spec

This is what Drone Surrogate Factory writes when you export **Drone spec**. A real export (the one in [`tests/fixtures/`](../tests/fixtures/factory-export.drone.json), minus its `generated`, `disclaimer` and `summary` lines, which are ignored here):

```json
{
  "format": "drone-surrogate-spec/3",
  "spec": {
    "version": 3,
    "name": "Factory Export Fixture",
    "layout": "quad_x",
    "envelope": { "length": 0.7, "width": 0.7, "height": 0 },
    "ratios": { "rotor": 0.397, "bodyL": 0.695, "bodyW": 0.255, "bodyH": 0.185, "armR": 0.031, "motorR": 0.034, "motorH": 0.048, "bladeChord": 0.048, "gearH": 0.1, "wingRoot": 0, "wingTip": 0, "wingSweep": 0, "wingThick": 0, "wingDihedral": 0, "tailScale": 1 },
    "body": { "shape": "capsule", "gear": "skids", "tail": "none", "thrust": "nose", "gpsMast": false, "antennas": 0, "gimbal": true },
    "internals": {
      "frameMaterial": "carbon", "motorId": "m3110", "propBlades": 3, "propMaterial": "plastic",
      "battery": { "chemistry": "lipo", "cells": 4, "capacityMah": 18100, "position": -0.025 },
      "avionics": "pro"
    },
    "weapons": [{ "id": "kinetic", "mount": "belly" }],
    "systems": [{ "id": "radar", "mount": "top" }],
    "livery": { "primary": "#C9D1D9", "secondary": "#2B3540", "accent": "#FF6B2C", "finish": "satin", "pattern": "split" }
  }
}
```

A bare spec object (the part inside `"spec"`, with `"version": 3`) works too.

**You can leave fields out.** Anything missing is filled from the defaults for that airframe, so a hand-trimmed spec only needs `version`, `layout` and `envelope`. Anything you do give is checked, and wrong values are reported by field name (for example `body.shape "sphere" must be one of: capsule, box, pod, tube, wedge`).

| Field | Meaning |
| --- | --- |
| `version` | `3`. |
| `name` | Display name. |
| `origin` | `design`, `replica`, `import` or `remix`. Informational. |
| `layout` | Airframe id. |
| `envelope` | `length`, `width` in metres (see the table in [Airframes](#airframes)); `height` is optional. |
| `ratios` | Proportions as fractions of the envelope (rotor size, body, arms, wings, tail). They shape the 3D model and the aerodynamics. |
| `rotorDiameterOverride` | Metres. Use a published rotor diameter instead of the one derived from `ratios.rotor`. |
| `body` | Hull shape, landing gear, tail, thrust direction, antennas, gimbal. |
| `internals` | `motorId`, `propBlades` (2 to 6), `propMaterial`, `frameMaterial`, `avionics`, and `battery` (`chemistry`, `cells`, `capacityMah`, `position` from -1 aft to 1 forward). |
| `weapons`, `systems` | Lists of `{ id, mount }`. Up to 2 of each. |
| `livery` | Colours, `finish` (`matte`, `satin`, `gloss`) and `pattern` (`solid`, `split`, `stripe`, `digital`, `hazard`). |
| `publishedMassKg` | A published mass to show beside the model's own estimate. |
| `notes` | Free text. |

`imported` (a custom 3D mesh in the factory) is not supported here. A file that has one still loads, with a warning, and the drone is drawn with its generic airframe.

## Values

### Airframes

<!-- TABLE:layouts -->
| id | Airframe | Flies as | Notes | `length` × `width` mean |
| --- | --- | --- | --- | --- |
| `quad_x` | Quad X | multirotor | The default for camera and inspection drones. | rotor tip to rotor tip, diagonal frame |
| `quad_plus` | Quad + | multirotor | One rotor leads; simple and symmetric. | rotor tip to rotor tip, in-line frame |
| `quad_h` | Quad H | multirotor | Wide stance, long body for payload bays. | rotor tip to rotor tip; wide lateral stance |
| `tri_y` | Tricopter Y | multirotor | Three arms. Light, agile, a little twitchy. | rotor tip to rotor tip; single rear boom |
| `hexa_x` | Hexa X | multirotor | Six rotors: survives a motor failure. | rotor tip to rotor tip |
| `hexa_plus` | Hexa + | multirotor | Six rotors, one leading. | rotor tip to rotor tip |
| `octo_x` | Octo X | multirotor | Heavy lift cinema and industrial work. | rotor tip to rotor tip |
| `octo_plus` | Octo + | multirotor | Eight rotors on eight arms. | rotor tip to rotor tip |
| `y6` | Y6 coaxial | multirotor | Coaxial pairs on three arms. Compact for its lift. | rotor tip to rotor tip; three arms, six rotors |
| `x8` | X8 coaxial | multirotor | Coaxial pairs on four arms. Redundant heavy lift. | rotor tip to rotor tip; four arms, eight rotors |
| `vtol_quadplane` | VTOL quadplane | VTOL | Takes off like a quad, cruises like a plane. | W is WINGSPAN, L is fuselage length — not rotor tips |
| `fixed_wing` | Fixed-wing | aeroplane | Fast and efficient. Needs speed to stay up. | W is WINGSPAN, L is fuselage length |
| `heli` | Helicopter | helicopter | One big rotor: efficient hover, long reach. | L is nose to tail including the disc; W is main rotor diameter |
<!-- /TABLE:layouts -->

Size limits: `length` and `width` must each be between **0.08 m and 6 m**.

### Weapons

At most two per drone. All are fictional game modules with abstract stats, not models of real weapons.

<!-- TABLE:weapons -->
| id | Name | Mass | Power | Mounts | What it does |
| --- | --- | --- | --- | --- | --- |
| `kinetic` | KN-7 Kinetic Turret | 1.35 kg | 35 W | belly, nose | Rapid single-shot projectiles. Spread grows on light, twitchy airframes. (ammo 240, rate 7, damage 10, spreadDeg 0.9, speed 280, range 350, recoil 0.9) |
| `bomb` | GB-4 Gravity Rack | 1.65 kg | 5 W | belly, left, right | Four unpowered drop payloads. Lead your release: they keep your speed. (ammo 4, damage 80, blastM 7, range 0) |
| `net` | NL-3 Net Launcher | 0.85 kg | 6 W | nose, belly | Captures drones intact. Short range, generous spread. (ammo 4, speed 38, range 32, netM 4.2) |
| `missile` | MH-2 Micro-Missile Pod | 1.1 kg | 12 W | left, right, belly | Two homing rounds. Hold a target in the reticle to lock. (ammo 2, damage 60, lockS 1.1, range 420, speed 90) |
| `laser` | LD-1 Laser Designator | 0.32 kg | 18 W | nose, belly | Paints targets: painted targets score double and show through walls. (range 800, ammo unlimited) |
| `emp` | EP-9 Pulse Emitter | 1.4 kg | 220 W | top, belly | Disables every drone in a bubble. Long recharge, big power draw. (radius 18, cooldownS 12, ammo recharge) |
<!-- /TABLE:weapons -->

### Systems

At most two per drone.

<!-- TABLE:systems -->
| id | Name | Mass | Power | Mounts | What it does |
| --- | --- | --- | --- | --- | --- |
| `radar` | RX-1 Compact Radar | 0.7 kg | 45 W | top, nose | Shows every target within range on the minimap, through terrain. |
| `lidar` | Livox Avia LiDAR | 0.498 kg | 8 W | nose, belly | Live non-repetitive point cloud in flight. Datasheet mass and power. |
| `thermal` | TH-640 Thermal Camera | 0.23 kg | 4 W | nose, belly | Heat vision. Engines and motors glow through night and smoke. |
| `carrier` | CB-3 Carrier Bay | 1.9 kg | 15 W | belly | Launches three micro-drones that scout and harass targets. |
| `searchlight` | SL-20 Searchlight | 0.42 kg | 60 W | nose, belly | 20,000 lumen steerable light. Essential after dark. |
| `smoke` | SD-6 Smoke Dispenser | 0.55 kg | 2 W | tail, belly | Six canisters. Breaks missile locks and hides you from sentries. |
| `winch` | WH-15 Cargo Winch | 0.95 kg | 30 W | belly | Hook, lift and deliver crates. The load swings — fly smooth. |
| `stealth` | RAM Stealth Skin | scales with the airframe | - | top | Radar-absorbing, low-reflectivity coat. Cuts RCS and LiDAR returns. |
| `parachute` | PR-2 Recovery Chute | scales with the airframe | - | top | Saves the airframe once: a crash becomes a soft landing. |
<!-- /TABLE:systems -->

### Motors (full spec only)

Recipes choose the motor for you. In a full spec, `internals.motorId` is one of these.

<!-- TABLE:motors -->
| id | Motor | Cells | Max power | Mass | Prop (m) |
| --- | --- | --- | --- | --- | --- |
| `m0802` | 0802 · 19000KV micro | 1S | 28 W | 0.0025 kg | 0.03-0.045 |
| `m1103` | 1103 · 10000KV | 1-2S | 70 W | 0.0042 kg | 0.045-0.065 |
| `m1404` | 1404 · 3800KV | 3-4S | 220 W | 0.0095 kg | 0.07-0.1 |
| `m2306` | 2306 · 2450KV racer | 4-6S | 850 W | 0.032 kg | 0.115-0.14 |
| `m2810` | 2810 · 1100KV | 4-6S | 900 W | 0.058 kg | 0.17-0.21 |
| `m3110` | 3110 · 900KV | 4-6S | 760 W | 0.08 kg | 0.21-0.26 |
| `m3510` | 3510 · 700KV | 4-6S | 650 W | 0.105 kg | 0.26-0.33 |
| `m4114` | 4114 · 400KV | 6S | 900 W | 0.16 kg | 0.33-0.41 |
| `m5015` | 5015 · 340KV | 6-12S | 1300 W | 0.21 kg | 0.38-0.46 |
| `m6215` | 6215 · 170KV | 12S | 2200 W | 0.39 kg | 0.48-0.61 |
| `m8318` | 8318 · 100KV | 12-14S | 3500 W | 0.69 kg | 0.66-0.76 |
| `mU15` | U15 heavy-lift · 80KV | 12-24S | 9000 W | 2.3 kg | 0.95-1.12 |
<!-- /TABLE:motors -->

### Other choices

| Field | Choices |
| --- | --- |
| `body.shape` | `capsule`, `box`, `pod`, `tube`, `wedge` |
| `body.gear` | `skids`, `legs`, `rails`, `none` |
| `body.tail` | `conventional`, `t_tail`, `v_tail`, `none` (aeroplanes) |
| `body.thrust` | `nose`, `pusher` (aeroplanes) |
| `internals.frameMaterial` | `polymer`, `carbon`, `aluminium`, `ti_carbon` |
| `internals.avionics` | `hobby`, `pro`, `mil` |
| `internals.propMaterial` | `plastic`, `carbon` |
| `internals.battery.chemistry` | `lipo` (high current), `liion` (long endurance), `solid`, `hydrogen` (hours of flight, heavy stack) |
| mounts | `belly`, `nose`, `top`, `tail`, `left`, `right` (the last two are pylons) |

## "Not flight-ready"

A drone can be a valid file and still be unable to fly. The model checks that the motors can lift the aircraft (thrust-to-weight), that the battery can supply the current, that the balance is sane and that the loadout fits. When a check fails the picker shows **Not flight-ready** with the model's first piece of advice, and **Launch** is disabled.

The usual cause is a heavy loadout on a small airframe: a 1.35 kg turret and a 0.7 kg radar on a 0.3 m quad is more than its motors can lift. Make it bigger, drop a module, or choose lighter ones. `npm run drone:new` refuses to write a drone that cannot fly unless you pass `--force`.

## How strict is the loader?

Everything is validated and every problem is reported in one go, with the field name and the allowed values. Nothing is silently "fixed" except the things listed above (missing spec fields get defaults; an imported mesh is dropped with a warning). The rules live in [`src/lib/spec.ts`](../src/lib/spec.ts) and are covered by [`tests/drones.test.ts`](../tests/drones.test.ts).
