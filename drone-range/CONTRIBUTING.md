# Contributing to Drone Range

Thanks for wanting to make this better. The easiest way to help is to **add a drone**; the most useful way is to **add a mission, weapon or environment**. Both are small, well-marked changes.

## Set up

```bash
git clone https://github.com/YOUR-USER/drone-range.git
cd drone-range
npm install      # Node 20 or newer
npm run dev      # http://localhost:5173
```

## Before you open a pull request

Run these. CI runs the same ones.

```bash
npm run typecheck                  # TypeScript, strict
npm run drone:check                # every file in src/drones/ loads and can fly
npm run docs:tables -- --check     # generated tables in the docs match the code
npm test                           # headless tests, no browser needed
npm run build                      # production build
```

If `docs:tables -- --check` fails, run `npm run docs:tables -- --write` and commit the result. Never edit text between `<!-- TABLE:... -->` markers by hand.

## What to send

**A drone.** Add one `*.drone.json` to `src/drones/`; it appears in the picker with no code change. [`docs/DRONE_FORMAT.md`](docs/DRONE_FORMAT.md) explains the format and `npm run drone:new` writes a first draft. A good bundled drone is good at something (a racer, a hauler, a long-range scout), flies sensibly, and does not duplicate one already there. Fly it in two or three environments before you submit it.

**A weapon, system, mission or environment.** [`docs/EXTENDING.md`](docs/EXTENDING.md) lists the files to touch for each, in order. Please include a test: the rules run headless, so a test is usually a few lines (see `tests/sim.test.ts`).

**A fix.** Open an issue first if the fix is large or changes how something feels. For a small one, a pull request with a test that fails before and passes after is ideal.

**Something bigger** (replays, a mission editor, touch controls, online leaderboards). Open an issue with the "Idea" template and sketch how it would work before you build it. Some of these are listed at the bottom of [`docs/EXTENDING.md`](docs/EXTENDING.md).

## Ground rules

- **It is a game.** Weapons and sensors are fictional, abstract modules with invented stats. Please do not submit real-world weapon designs, real ballistic or targeting data, or anything meant to help someone build or use an actual weapon. A new module should be fun and readable, not realistic.
- **Keep the rules free of the browser.** Code in `src/engine/` and the rules in `src/sim/` (`game.ts`, `flight.ts`, `world.ts`, `catalog.ts`) must not import React or touch the DOM. That is what lets tests and bots run the game headless.
- **Keep it deterministic.** Anything that affects the rules uses `this.rnd` (the seeded generator), not `Math.random()`. Visual and audio effects may use `Math.random()`.
- **Numbers belong in data.** Put tuning values in a module's `stats` or in `catalog.ts`, not scattered through `game.ts`.
- **No new runtime dependencies** without an issue first. The dependency list is short on purpose, and three.js already makes the download sizeable.
- **Strict TypeScript.** No `any`, no `// @ts-ignore`. Comments explain why, not what.
- **Be honest in the docs.** If something is an estimate, an approximation or untested, say so.

## Reporting a bug

Use the "Bug report" template. The most useful report has: what you did, what you expected, what happened, your browser and operating system, and, for a drone problem, the drone file. The browser console (F12) often has the answer.

## Be kind

People here are at every level, from first-time contributors to people who have written flight controllers. Assume good faith, explain your reasoning, and keep reviews about the code.

By contributing you agree that your work is released under the [MIT license](LICENSE).
