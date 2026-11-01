# Extending Drone Range

Everything below is a real extension point in the code, with the file and function to open. Each recipe ends with how to test it. The simulator rules (`Game`) run without a browser, so most changes can be tested headless in a few lines; see [`tests/sim.test.ts`](../tests/sim.test.ts).

After you add a weapon, system, mission or environment, refresh the reference tables in the README and `docs/DRONE_FORMAT.md`. They are generated from the code, so there is nothing to edit by hand:

```bash
npm run docs:tables -- --write
```

CI runs `npm run docs:tables -- --check` and fails if a table is stale.

Contents: [a drone](#add-a-drone) · [a weapon](#add-a-weapon) · [a system](#add-a-system) · [a mission](#add-a-mission) · [an environment](#add-an-environment) · [ideas](#ideas-that-would-be-welcome)

---

## Add a drone

No code. Write a [recipe](DRONE_FORMAT.md), or use the command line, and the drone shows up after a reload:

```bash
npm run drone:new -- --name "Picket" --layout quad_x --length 0.9 --weapon kinetic --system radar
npm run drone:check
```

## Add a weapon

A weapon touches seven places. Use `emp` (simple, one button) or `missile` (lock-on, a projectile that steers) as the model to copy.

1. **Declare it** in [`src/engine/parts.ts`](../src/engine/parts.ts). Add its id to the `WeaponBehaviour` union and an entry to `WEAPONS` (a `ModuleDef`): `name`, `short`, `massKg`, `powerW`, `priceUsd`, `dragM2`, the `mounts` it fits, a `glyph`, a one-line `blurb` and a `stats` object. `stats` is where the tuning numbers live (`rate`, `damage`, `range`, `ammo`, ...), so the game code reads them instead of hard-coding them. Mass, power and drag are not just labels: the performance model uses them, so a heavy weapon really does cost speed and flight time.
2. **Give it a body** in `moduleMesh` in [`src/engine/geometry.ts`](../src/engine/geometry.ts): a `case 'yourid'` that builds the mesh from boxes and cylinders and sets `muzzle` (where shots leave, in the model frame) and `height`. Also add its height to `MODULE_HEIGHT` in [`src/engine/points.ts`](../src/engine/points.ts).
3. **Make it fire** in `updateWeapons` in [`src/sim/game.ts`](../src/sim/game.ts). Each weapon is an `if (id === '...')` branch inside the loop over `this.weapons`. `held` is true while the fire button is down, `pressed` only on the frame it goes down. `muzzle` is the world position of the barrel and `dir` is the unit vector towards what the reticle is on. Read the weapon's numbers from `s` (its `stats`), spend `w.ammo`, set `w.cd` for the cooldown, and push a `Projectile` and/or an `Effect`. Use `this.stats.shots++` for anything that should count towards the accuracy bonus.
4. **Move and hit** in `updateProjectiles` if it launches a new kind of projectile: add the kind to `ProjKind`, then handle its flight and what it does on impact (`damageEntity`, `explode`, `capture` are the existing outcomes).
5. **Draw it.** Projectile colours and sizes are in `Projectiles` in [`src/sim/Scene.tsx`](../src/sim/Scene.tsx); one-shot visuals use the `EffectKind` list in `game.ts` and `Effects` in `Scene.tsx`.
6. **Sound.** Add a `SoundKind` in `game.ts` and a case in [`src/sim/audio.ts`](../src/sim/audio.ts). Sounds are synthesised, there are no audio files.
7. **HUD.** Ammo and cooldown show automatically. A weapon with extra state (the missile's lock) gets its own lines in [`src/sim/Hud.tsx`](../src/sim/Hud.tsx).

If the new weapon deals damage, add its id to `DAMAGING` in [`src/sim/catalog.ts`](../src/sim/catalog.ts) so the Target Range accepts it.

**Test it.** Copy the Target Range test in `tests/sim.test.ts`: build a `Game` with a drone that carries the weapon, park the craft near a target, call `g.update(STEP, input, [true, false])` in a loop, and assert on `g.score`, `g.stats` or the target's `state`.

## Add a system

Systems are passive or toggled equipment (radar, LiDAR, thermal, searchlight, smoke, winch, stealth skin, parachute, carrier bay).

1. **Declare it** in `parts.ts` (`SystemBehaviour` and `SYSTEMS`) and give it a body in `moduleMesh` in `geometry.ts` and an entry in `MODULE_HEIGHT`, exactly as for a weapon.
2. **Register it** in the `Game` constructor in `game.ts`: systems that start switched on are listed in the `active` expression, and limited-use ones get a charge count (`smoke` 6, `carrier` 3, `parachute` 1).
3. **Toggle it** in `toggleSystem`. A system that falls through to the bottom of that function is a plain on/off switch and needs no code. One-shot systems (smoke, the carrier bay) have their own branch, and passive ones (parachute, stealth, winch) only show a message.
4. **Use it** wherever the rules should change. Ask the game with `this.sysOn('id')` (equipped and switched on) or `this.has('id')` (equipped). For example radar lets you see every target within 900 m on the minimap (`updateSeen`) and speeds up Recon scans (`updateMission`), stealth shortens how far sentries notice you (`stealthFactor`), and thermal changes how the world is drawn (`Hud.tsx`, and the `thermal` flag of `Lights` in `Scene.tsx`).

**Test it.** Build two `Game`s that differ only in the system and compare an outcome (the net test in `tests/sim.test.ts` is the closest example: it builds one game, fires, and checks what the score does).

## Add a mission

A mission is a goal, a time limit and a score.

1. **Declare it** in [`src/sim/catalog.ts`](../src/sim/catalog.ts): add its id to `MissionId` and an entry to `MISSIONS` with a name, blurb, `timeLimit` in seconds (0 for none), three `stars` thresholds, a glyph and, if the drone must carry something, a `needs` function that returns a message or `null`.
2. **Spawn its world** in `setupMission` in `game.ts`: targets, rings, pads, zones or hostile drones. `freeSpot` finds a clear place at a distance from the launch pad, and the game's seeded random generator (`this.rnd`) keeps the layout the same for the same seed.
3. **Run its rules** in `updateMission`, which is called every physics step, and report progress from `objective()` (`label`, `detail`, `done`, `total`). `checkEnd` ends the run as `complete` when `done` reaches `total` (Free Flight and Survival have no finish line).
4. **Pay out** with `this.add(points, 'Label')`. Labels become the lines of the end-of-run breakdown. Time and accuracy bonuses are added in `finish`.
5. **Show it.** `Objectives` in `Scene.tsx` draws rings, zones and pads; a new kind of marker goes there. The mission card on the start screen reads `MISSIONS` automatically; the one-line hint under each card is the `fit` function in [`src/pages/Home.tsx`](../src/pages/Home.tsx).

**Test it.** Build a `Game` on the mission with the `game()` helper from `tests/sim.test.ts`, step it with scripted input, and assert on `g.objective()`, `g.over` and `g.score`.

## Add an environment

1. **Declare it** in `catalog.ts`: add the id to `EnvId` and an entry to `ENVIRONMENTS` (sky colours, ground colour, wind, fog density, `night`).
2. **Build the world** in `buildWorld` in [`src/sim/world.ts`](../src/sim/world.ts): a terrain `height` function and the obstacles for your `kind` (`buildings`, `boxes`, `trees`, `lamps`). The world is generated from a seed with no assets, so it is the same every time.
3. **Dress it.** [`src/sim/Scene.tsx`](../src/sim/Scene.tsx) has a few environment-specific branches (street texture, water, tree style) and the minimap colours are in `Hud.tsx`.

**Test it.** `tests/sim.test.ts` already loops over every environment and checks that ring courses never pass through a building, so a new environment is covered as soon as it is in `ENVIRONMENTS`.

## Ideas that would be welcome

- More drones. Send a pull request with a file in `src/drones/`.
- A mission editor, or missions loaded from JSON the way drones are.
- Wind that varies across the map, or weather (rain, snow, low cloud).
- Better enemies: formations, evasive manoeuvres, ground defences that shoot back.
- Replays: the physics is deterministic for a seed, so recording the inputs is enough to replay a run.
- A bot or reinforcement-learning harness. `Game` has no dependency on the DOM or WebGL, so an agent can fly it headless at many times real time.
- Online leaderboards (scores are local today, in `src/lib/scores.ts`).
- Touch controls that feel as good as the keyboard.
- Custom 3D meshes for a drone (the factory app supports them; this repo does not).
