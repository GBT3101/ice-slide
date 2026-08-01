# Ice Slide

**▶ Play it live: <https://gbt3101.github.io/ice-slide/>**

The game is deployed on GitHub Pages, served straight from the `main` branch at
the repo root — there is no build step and no deploy workflow. **Every push to
`main` publishes the site**, so any change committed here goes live within a
minute or two. Check the live URL after pushing.

A tiny 2D ice-scroller that also runs locally in any browser.

You are a green square sliding endlessly on ice. Gaps and hazards scroll in from the right — jump with **Space** (or click / tap) or you fall and lose.

## Run locally

No build step or server required (same as on Pages). Either:

1. **Double-click** `index.html` to open it in your browser, or
2. From this folder, serve it (optional, useful if your browser blocks local modules):

```bash
# Python
python3 -m http.server 8000

# Node (if you have npx)
npx serve .
```

Then open [http://localhost:8000](http://localhost:8000).

## Controls

| Key / input | Action        |
|-------------|---------------|
| `Space` / click / tap | Jump (or start / restart) |
| `R`         | Restart anytime |
| `Esc`       | Close the Instructions screen |

On touch devices every one of those has an equivalent: tap anywhere on the
playfield to jump (hold for height), tap the game-over screen anywhere to run
again, and the **⟲** button in the HUD corner stands in for `R`.

## Mobile

The game is landscape-only. On a coarse-pointer device `game.js` stamps three
classes on `<body>` — `is-touch`, `is-portrait-locked`, `is-fullscreen` — and
`style.css` reads nothing but those, so the CSS and the JS can never disagree
about which mode is live:

- **Portrait** puts up a full-screen "turn your device" gate and freezes the
  simulation. Rotating back shows a *Paused — tap to resume* card rather than
  dropping the player straight into a mid-air frame; leaving the tab or app
  mid-run pauses the same way.
- **Landscape** hands the whole viewport to the canvas: header, page HUD and
  footer drop out, score/best/restart move into an overlay inside the canvas
  frame, and the playfield goes edge-to-edge.

The world stays **400 logical units tall** always — every physics tunable is
calibrated against that — and only the width flexes to match the viewport
aspect, clamped to `800…1120` so the look-ahead ahead of the player never gets
too short to read (or too wide for the parallax ridge). Aspect ratios outside
that range letterbox. The backing store is sized by `devicePixelRatio`, so the
art is crisp on retina screens on desktop too.

## Front end

- **Entrance screen** — a DOM layer over the canvas, so the live idle world
  (sky, aurora, mountains, drifting snow, the bobbing square) is the moving
  backdrop rather than a static image. Two actions: **RUN!** and
  **Instructions**.
- **Instructions ("Field Manual")** — enemies/hazards and powerups side by
  side. The enemy rows come from `ENEMY_TYPES` (plus `HAZARD_INFO` for the
  static level hazards) and the powerup rows are the dropper pool,
  `POWERUP_DROP_IDS`, described with each id's `POWERUP_DEFS` entry. Each icon
  is painted by the **game's own draw functions** onto a small canvas
  (`drawManualIcon`), so the art and the unlock scores in the manual can't
  drift from the real game. Register a new enemy or powerup with `name` +
  `desc` and it shows up here on its own.
- **Game over** — `RUN AGAIN` restarts, `Menu` returns to the entrance screen.

## Gameplay

- The square **auto-slides** to the right (world scrolls left).
- **Gaps** in the ice — miss the jump and you fall.
- **Spikes** and **ice crates** on platforms — side contact kills you. **Ice
  crates** can be **stomped** from above like an enemy: they shatter and you get
  the same bounce. Spikes never can.
- **Floating ice platforms** appear sometimes for extra routes.
- **Milestone signs** every **100** points — planted into the ice, or floating in a **bubble** if that mark falls over a gap.
- After **100** points: **red raiders** approach — **stomp** from above to squash them; only side contact kills you. Time **Space** on a stomp for a boost jump (~**2×** normal height if held).
- After **300** points: **yellow ? droppers** appear — stomp them to grant a **random powerup** (equal chance for each):
  - **Shield** — bubble for **10s**, absorbs one hit, blinks in the last **2s**.
  - **Wings** — held until used; press **Space** in the air for one extra jump (wings pop).
  - **Gun** — for **10s**, auto-shoots on-screen enemies ahead; blinks in the last **2s**.
  - **Bridge** — held until used; the next time you fall into a gap, a bridge is placed and you slide across it.
- After **1000** points: **gunners** (armed raiders) appear and shoot.
- Enemies and powerups use registry tables in `game.js` (`ENEMY_TYPES`, `POWERUP_DEFS`, `POWERUP_DROP_IDS`) so new kinds are easy to add.
- Every **1000** points: the **environment theme** shifts (sky, aurora, ice tint) and **fireworks** pop in the sky.
- Speed ramps up the longer you survive. Score is based on distance.
- Best score is saved in `localStorage`.

## Files

```
index.html   — page shell, entrance screen & instructions markup
style.css    — layout, UI & front-end animation
game.js      — game loop, physics, drawing, front end
README.md    — this file
```
