# NEON RUSH

A fast three-lane neon endless runner for **FreeArcadeHub**. It's a standalone static HTML5 game built with TypeScript, Vite and Canvas 2D.

- No backend, login, accounts, analytics or advertising. Nothing is fetched from third-party servers.
- Records and settings are stored locally (`localStorage`, versioned). The game still runs when storage is blocked.
- All graphics are drawn procedurally with Canvas, CSS and inline SVG. All audio is synthesised with the Web Audio API. There are no image or audio files to load.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm run dev        # local development server (http://localhost:5173)
```

## Build and preview

```bash
npm run build      # type-check (tsc) + production build into dist/
npm run preview    # serve dist/ at http://localhost:4173
```

`dist/` is a plain static site (`index.html`, one JS file, one CSS file and a favicon). Asset URLs are **relative** (`base: './'`), so the same build works at a domain root, in any sub-folder (for example `/games/neon-rush/`), and inside an iframe.

## Tests

```bash
npm run typecheck  # strict TypeScript (no linter is configured; strict tsc + noUnused* is the lint gate)
npm test           # Vitest: physics, collisions, scoring, difficulty, save data, track fairness
npm run test:e2e   # builds, then drives a real browser through the production build
npm run check      # typecheck + unit tests + build
```

### What the unit tests cover (`tests/`)

- **Player physics:** lane clamping, lane-change time, jump height and duration, jump buffering, slide duration, fast-fall, and jump cancelling a slide.
- **Collision:** barriers must be jumped, gates must be slid under, and blocks and walls can't be jumped or slid. Adjacent lanes never collide, and z extents are respected.
- **Fairness:** an exhaustive input search runs the *real* player physics and collision code. At 30 inputs per second it proves that some sequence survives generated tracks to 2,500 m (8 seeds), 5,000 m and 9,500 m (top speed tiers). Negative controls show the solver does reject impossible courses.
- **Generator invariants:** deterministic per seed, a safe intro, a survivable lane in every row, minimum spacing, and gradual introduction of obstacle types.
- **Difficulty:** speed is monotonic, has no spikes and is capped. Levels advance one at a time.
- **World:** score formula, a single crash, a clean reset, and no pool overflow over 15 km.
- **Save data:** persistence across instances, malformed JSON, invalid values, legacy migration, and throwing or missing storage.

### What the browser test covers (`scripts/e2e.mjs`)

It uses `playwright-core` with a locally installed Edge or Chrome; no browser download is needed. Set `BROWSER_PATH` to use another Chromium executable. The production build is served from a sub-path on one origin, and a parent page on a **different origin** embeds it in an iframe. The script checks:

- Menu, panels, keyboard play, lane clamping, and jump and slide timing.
- Score, orbs and speed rising while running.
- Pause and resume, plus tab-hidden auto-pause.
- Canvas resizing.
- A crash producing exactly one game-over.
- Restart without duplicate animation loops.
- Records and sound settings persisting after reload.
- Audio staying locked until a gesture.
- Touch swipes (one action per gesture), on-screen touch buttons, and portrait and landscape layouts.
- Blocked `localStorage` and the system reduced-motion preference.
- Play inside the cross-origin iframe.
- No external or ad requests, and no ad code or local URLs in `dist/`.

Screenshots are written to `test-results/`.

## Deploying (static hosting)

The game does not need a server runtime. Upload the contents of `dist/` to any static host.

**Vercel:** import the repository in Vercel and deploy. The included `vercel.json` sets the framework (Vite), install command `npm ci`, build command `npm run build` and output directory `dist`. It also adds long-lived caching for hashed assets and basic security headers. It deliberately sets no `X-Frame-Options` or `frame-ancestors`, so FreeArcadeHub can embed the game. No environment variables are required.

**Netlify / Cloudflare Pages / GitHub Pages / S3:** build command `npm run build`, publish directory `dist`.

### Embedding in FreeArcadeHub

```html
<iframe
  src="https://YOUR-GAME-DOMAIN/"
  title="NEON RUSH"
  allow="fullscreen; autoplay"
  allowfullscreen
  style="width:100%;aspect-ratio:16/9;border:0"
></iframe>
```

- The game sizes itself to the iframe with a `ResizeObserver`. Any size or aspect ratio works, in portrait or landscape.
- It never accesses the parent page, never navigates `top`, and needs no `postMessage`.
- `allow="fullscreen"` enables the optional Fullscreen button. Without it, the button is hidden.
- Sound starts only after the player interacts inside the frame.
- If the hub sends a `Content-Security-Policy`, the game needs only `'self'` for scripts, styles and images. It uses no inline scripts, `eval` or remote resources.

## How to play

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move left / right | ← → or A / D | Swipe left / right |
| Jump | ↑, W or Space | Swipe up |
| Slide (fast-drop in the air) | ↓ or S | Swipe down |
| Pause / resume | Esc or P | Pause button |
| Menu primary action | Enter or Space | Tap |

Optional on-screen touch buttons can be enabled in Settings.

The hazards:

- **Energy barriers** (low, amber, jump chevron): jump over them.
- **Laser gates** (overhead violet beam, down chevrons): slide under them.
- **Barricades** (crossed) and **freight pods** (long, striped): change lane. They can't be jumped.

### Scoring

```
score = distance points + 10 x energy orbs + 50 x close calls
distance points = sum over each metre of (1 + 0.25 x speed level index)
close call = leaving a barricade's or freight pod's lane less than 0.5 s before reaching it
```

### Difficulty

Speed eases from 15 m/s toward a hard cap of 33 m/s: `15 + 18 x (1 - e^(-d/2400))`. Speed levels start at 0.4, 1, 1.8, 3, 4.5, 6.5 and 9 km. The first 90 m are empty, and level 1 uses only single obstacles. Two-lane patterns, full-width rows, long freight pods and mixed combinations unlock gradually. Row spacing never drops below 0.9 s of travel.

Every candidate row is validated before it is accepted. From every lane that was survivable at the previous row, the player must be able to reach a survivable lane of the new row in time, without passing through a block or wall. That check accounts for lane-change time, reaction time and wall length.

## Developer / test URL options

| Parameter | Effect |
| --- | --- |
| `?seed=1234` | Every run uses this track seed (reproducible patterns). |
| `?debug=1` | Exposes `window.__NEON_RUSH__` with `snapshot()`, `setInvulnerable(bool)` and `fastForward(seconds)` for automated tests. It is not active in normal play. |

## Project structure

```
index.html              markup for HUD, menus, panels and touch pad
public/favicon.svg
src/main.ts             boot + URL options
src/styles.css          UI styling (safe areas, responsive, reduced motion)
src/core/               config constants, seeded RNG, fixed-step rAF loop
src/game/player.ts      lanes, jump, slide, fast-fall (plain data, pure functions)
src/game/entities.ts    obstacle/orb types + exact collision tests
src/game/generator.ts   seeded pattern generator with fairness validation
src/game/difficulty.ts  speed curve, levels, spacing
src/game/scoring.ts     documented score formula
src/game/world.ts       DOM-free simulation of a run (pooled objects)
src/game/game.ts        state machine, loop wiring, events, persistence, visibility
src/render/             Canvas renderer, runner figure, skyline, particles
src/input/input.ts      keyboard, swipe (Pointer Events), touch buttons
src/audio/audio.ts      Web Audio synth: music sequencer + sound effects
src/storage/save.ts     versioned, validated localStorage save
src/ui/ui.ts            DOM screens, HUD, toasts, settings
tests/                  Vitest unit tests
scripts/e2e.mjs         browser end-to-end checks
```

### Game states

`loading -> menu -> ready (3-2-1) -> playing <-> paused -> ... -> gameover -> ready | menu`

- A single `requestAnimationFrame` loop drives a fixed 120 Hz simulation step, so game speed does not depend on the display refresh rate.
- Nothing advances while the game is paused.
- Hiding the tab or leaving the iframe while playing pauses the game, and it stays paused until the player resumes.
- Audio is suspended while the page is hidden.

### Performance

- Obstacles and orbs come from fixed pools, and particles use a fixed ring buffer.
- The sky and skyline are pre-rendered on resize.
- Glow uses additive sprites instead of `shadowBlur`.
- The device pixel ratio is capped at 2, and the backing store at about 2.4 megapixels.
- With Graphics set to Auto, the game switches to a lighter mode (fewer effects, lower resolution) if frame times stay above about 24 ms.
