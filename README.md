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
| `Esc`       | Close the Instructions, Skins or Shop screen |

### Testing shortcut (desktop, undocumented in-game)

`1`–`9` warp a live run to **1k–9k points**, and `0` lands at **9500** so the
10,000 ending can be watched arriving under its own steam. This lets the later
enemy tiers be
reached without the climb. The world is rebuilt at the new distance and the
speed ramp is fast-forwarded to match, so the stretch you land in plays exactly
like an honest run that got there. **A warped run never writes the saved best.**
Deliberately absent from the Field Manual — it is a test hook, not a feature.

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
  backdrop rather than a static image. Four actions: **RUN!**,
  **Instructions**, **Skins** and **Shop**.
- **Instructions ("Field Manual")** — enemies/hazards and powerups side by
  side. The enemy rows come from `ENEMY_TYPES` (plus `HAZARD_INFO` for the
  static level hazards) and the powerup rows are the dropper pool,
  `POWERUP_DROP_IDS`, described with each id's `POWERUP_DEFS` entry. Each icon
  is painted by the **game's own draw functions** onto a small canvas
  (`drawManualIcon`), so the art and the unlock scores in the manual can't
  drift from the real game. Register a new enemy or powerup with `name` +
  `desc` and it shows up here on its own.
- **Skins ("The Wardrobe")** — five cards, generated from `SKIN_DEFS` /
  `SKIN_ORDER`. Each preview is the **real player sprite** drawn onto a small
  canvas by `drawPlayer` with that skin temporarily active (`previewSkin`), so
  a card can never show something the run won't. The choice persists in
  `localStorage` under `iceSlideSkin`.
- **Shop** — free run modifiers, generated from `SHOP_DEFS` / `SHOP_ORDER`,
  with a warning at the top stating the deal: **equip anything and the score
  stops counting**. Two shelves — nine mutually exclusive **head start** chips
  (1,000 … 9,000) and five stacking **modifications**. Every tile is painted by
  the game's own art (the milestone sign board, the dropper sprite, the player
  wearing the shell / blaster / wings), same rule as the manual and the
  wardrobe. The loadout persists in `localStorage` under `iceSlideShop`.
- **Game over** — `RUN AGAIN` restarts, `Menu` returns to the entrance screen.

## Gameplay

- The square **auto-slides** to the right (world scrolls left).
- **Gaps** in the ice — miss the jump and you fall. **The first 300 points are
  one unbroken runway**: new players were dying to a gap before they had felt
  the jump at all, so nothing can drop you until the ice starts breaking up.
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
- After **2000** points: **purple winged raiders** — they ignore gravity and
  **glide over the gaps**, so they reach you where there is no ice to stand on.
  Still stompable; their cruise altitude is capped so the head always stays
  inside the jump budget.
- After **3000** points: **blue spikers** — head spikes **out for 1s, in for 1s**.
  Landing on them while the spikes are out kills you; stomp on the beat.
- After **4000** points: **black brutes** — **2×2** the size of a raider with
  glowing red eyes. Too tall to clear in one jump; go over the top.
- After **5000** points: **white spikers** — spikes that **never retract**.
  There is no stomping these; jump them or shoot them.
- After **6000** points: **lazer raiders** — they wind up a magenta beam
  (glowing emitter plus a dashed aim line) and then fire it along the ice for
  **100ms**. The beam only ever runs at raider mid-height, well under the jump
  apex, so **being airborne always clears it**. The wind-up is the warning; the
  beam is far too brief to react to on its own.
- After **7000** points: **ice raiders** — cyan, closing at **double** the usual
  approach speed on a frozen skid streak. Same stomp, much less time to set up.
- After **8000** points: **commando raiders** — they parachute in holding a
  **fixed screen X** while the ice scrolls past underneath, knife in their
  teeth. Stomp them in the air, or clear the patch of ice they are aiming for.
  One that drifts over a gap simply rides its chute into the abyss.
- After **9000** points: the **Ultimate Raider** — golden, airborne, armed, with
  burning white eyes and a radiating aura. Jump the shots and land on its crown.
- **The Shop (free, and it switches the score off).** Anything equipped makes
  the run a practice run: `startGame()` raises the same `warped` flag the warp
  keys use, which is the one thing that suppresses the best-score write in both
  `die()` and `winRun()`. A **FOR FUN · SCORE OFF** badge rides along in the
  corner and the game-over panel says so too. The items:
  - **Start at 1,000 … 9,000** — one per run. The world is rebuilt at that
    distance and the speed ramp fast-forwarded (`warpToScore`), so the stretch
    you drop into plays exactly like an honest run that got there.
  - **No Gaps** — holds the opening runway's rule for the whole run: slabs are
    merged instead of spaced, so there is not one hole in the ice. Spikes,
    crates and every raider still turn up.
  - **Double Droppers** — the dropper's spawn weight is doubled *at pick time*
    (`enemySpawnWeight`), never written back into `ENEMY_TYPES`, so unequipping
    it leaves honest runs untouched.
  - **Made of Steel** — 10 hit points of riveted shell over whatever skin is
    equipped. Every lethal contact costs one plate, cracks the shell, and
    **destroys what caused it**; a pip row over the square counts what is left.
    A shield still absorbs first. Falling into a gap is not a hit and still
    ends the run.
  - **Forever Gun** — the gun powerup granted permanently (`remaining` is
    `Infinity`, so it never ticks down and a dropper roll can't downgrade it).
  - **Fly** — the wings powerup, topped back up every time the square lands, so
    there is always exactly one extra jump in the air.
  Mods that hand out a powerup are re-granted every frame by
  `enforceShopPowerups()`, so nothing else in the file — dropper rolls, wings
  being spent, a mid-run warp — has to know the shop exists.
- Enemies, powerups, skins and shop items use registry tables in `game.js` (`ENEMY_TYPES`, `POWERUP_DEFS`, `POWERUP_DROP_IDS`, `SKIN_DEFS`, `SHOP_DEFS`) so new kinds are easy to add.
- **Skins are cosmetic, full stop.** A skin supplies `behind` / `body` /
  `features` art inside `drawPlayer`'s transform and nothing else — the hitbox
  is `PLAYER_SIZE` for all of them, and the death frame drops the costume so
  the red square stays an unambiguous signal. Palette rule for new skins:
  enemies own red, yellow, purple, blue, black and white, so stay out of those
  or the player loses track of their own square.
- Every **1000** points: the **environment theme** shifts (sky, aurora, ice tint) and **fireworks** pop in the sky.
- **The run ends at 10,000.** The scroll stops, the square is planted on solid
  ice (a slab is laid under it if the winning step landed over a gap), it turns
  to face you and smiles, and the sky fills with fireworks while raiders of
  every kind rain down and shatter around it. A **THANK YOU FOR PLAYING**
  banner drops in from above the canvas and bounces onto the floor beside the
  square — and **only once it has landed** does `Space` start a new run, so the
  finale can never be mashed through. An honest win always writes the best
  score; a warped one never does.
- Speed ramps up over the **first 20 seconds** (`280 → 400`) and then **stays
  flat for the rest of the run** — past roughly **680** points the scroll never
  gets faster again. Score is based on distance.
- The other difficulty ramps also plateau early: enemy approach speed by **2000**
  points, spawn density by **2700**, gap width and platform length by **~900**.
  Past 2700 the only thing that changes is which enemy types have unlocked.
- Best score is saved in `localStorage`.

## Files

```
index.html   — page shell, entrance screen, instructions, skins & shop markup
style.css    — layout, UI & front-end animation
game.js      — game loop, physics, drawing, front end
README.md    — this file
```
