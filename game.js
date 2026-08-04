(() => {
  "use strict";

  // ── Canvas & DOM ──────────────────────────────────────────────
  const canvas = document.getElementById("game");
  /**
   * The live draw target. Normally the game canvas, but menu icon rendering
   * temporarily points it at a small offscreen canvas (see withCtx) so every
   * sprite in the field manual is painted by the real game art functions.
   */
  let ctx = canvas.getContext("2d");
  const gameWrap = document.getElementById("game-wrap");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlayMsg = document.getElementById("overlay-msg");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const scoreElM = document.getElementById("score-m");
  const bestElM = document.getElementById("best-m");
  const menuScreen = document.getElementById("menu-screen");
  const menuBestEl = document.getElementById("menu-best");
  const manual = document.getElementById("instructions");
  const skinsModal = document.getElementById("skins");
  const shopModal = document.getElementById("shop");
  const hudMobile = document.getElementById("hud-mobile");
  const resumeGate = document.getElementById("resume-gate");

  /**
   * The world is 400 logical units tall, always. Every physics tunable
   * below (jump height, gravity, GROUND_Y) is calibrated against that,
   * so H is fixed and only W flexes to match the viewport's aspect.
   *
   * W is clamped: PLAYER_X is fixed at 140, so the visible look-ahead is
   * W - 140. Below ~800 a MAX_PLATFORM-length platform no longer fits on
   * screen and the run stops being readable; above ~1120 the parallax
   * mountains run out. Aspect ratios outside the clamp letterbox in CSS.
   */
  const BASE_W = 900;
  const MIN_W = 800;
  const MAX_W = 1120;
  const H = canvas.height;
  const GROUND_Y = H - 72;

  let W = BASE_W;
  /** Backing-store scale - re-applied every frame in draw(). */
  let renderScale = 1;

  // ── Tunables (feel first) ─────────────────────────────────────
  const PLAYER_SIZE = 36;
  const PLAYER_X = 140;

  // Jump derived from height + time-to-apex
  const JUMP_HEIGHT = 118;
  const TIME_TO_APEX = 0.32;
  const GRAVITY = (2 * JUMP_HEIGHT) / (TIME_TO_APEX * TIME_TO_APEX);
  const JUMP_VELOCITY = -(2 * JUMP_HEIGHT) / TIME_TO_APEX;
  const FALL_GRAVITY = GRAVITY * 1.75;
  const COYOTE_TIME = 0.1;
  const JUMP_BUFFER = 0.12;
  const JUMP_CUT = 0.45;

  const BASE_SPEED = 280;
  /**
   * Ceiling on the scroll ramp. The opening acceleration is the game's feel,
   * so the ramp stays - it just tops out early: 280 → 400 over the first 20s,
   * i.e. by ~680 pts, and never moves again. (At the old 520 it kept climbing
   * until ~1600 pts and left only 1.1s of warning on an approaching enemy;
   * 400 gives 1.33s.) Raise this and the run gets harder everywhere at once.
   */
  const MAX_SPEED = 400;
  const SPEED_RAMP = 6; // units/sec per second of run

  const MIN_GAP = 70;
  const MAX_GAP = 130;
  const MIN_PLATFORM = 180;
  const MAX_PLATFORM = 380;
  /**
   * Unbroken ice until 300 pts. New players were dying to a gap before they
   * had felt the jump at all, so the opening stretch is a runway: spikes and
   * crates still appear (they teach the jump), but nothing can drop you.
   */
  const GAP_FREE_UNTIL_SCORE = 300;
  /** Derived from W - recomputed by layout(), never read before it runs. */
  let SPAWN_AHEAD = W + 200;

  // Milestone tuning
  const SIGN_INTERVAL = 100; // points between ice signs
  const THEME_INTERVAL = 1000;
  const SCORE_TO_DIST = 10; // score = distance * 0.1

  /**
   * The run has an end. At 10,000 the ice stops moving, the sky fills with
   * fireworks and the square finally gets to look at you. See winRun().
   */
  const WIN_SCORE = 10000;
  const VICTORY_TITLE_START = -90; // banner waits off the top of the canvas
  const VICTORY_TITLE_DELAY = 0.9; // let the fireworks land first
  const VICTORY_TITLE_FALL = 1.9; // seconds of descent
  const VICTORY_DROP_INTERVAL = 0.16; // seconds between raiders raining down
  /** Where the banner comes to rest - down on the floor, level with the square. */
  const VICTORY_TITLE_REST = GROUND_Y - 46;

  // ══════════════════════════════════════════════════════════════
  // ENEMY SYSTEM (scalable)
  // ──────────────────────────────────────────────────────────────
  // HOW TO ADD A NEW ENEMY (for future agents):
  //   1. Add an id to EnemyKind below.
  //   2. Register a full entry in ENEMY_TYPES (unlockScore, spawnWeight,
  //      canShoot, dropPowerup, lethalOnContact, draw style keys…), plus the
  //      manual fields: name + desc (shown in the Instructions screen, which
  //      is generated straight from this table - no second list to update).
  //   3. If it needs unique art, extend drawEnemyInstance() with a branch
  //      on e.type (see "dropper" / "gunner" for patterns).
  //   4. Optional behavior hooks: onStomp via dropPowerup / custom flags;
  //      shooting via canShoot + updateEnemyBehavior().
  //   5. Spawning is automatic once unlockScore is met (weighted pick).
  //
  // Current roster:
  //   raider  - regular red angry square. Unlocks at 100 pts.
  //   dropper - yellow "?" powerup carrier. Unlocks at 300 pts. Stomp = powerup.
  //   gunner  - armed red raider with blaster. Unlocks at 1000 pts.
  //   flyer   - purple winged raider, ignores gravity. Unlocks at 2000 pts.
  //   spiker  - blue raider, spikes out 1s / in 1s. Unlocks at 3000 pts.
  //   brute   - black 2×2 hulk with glowing eyes. Unlocks at 4000 pts.
  //   frost   - white raider, spikes never retract. Unlocks at 5000 pts.
  //   laser   - charges, then fires a ground-level beam. Unlocks at 6000 pts.
  //   slider  - cyan raider at double approach speed. Unlocks at 7000 pts.
  //   commando- parachutes in at a fixed screen X. Unlocks at 8000 pts.
  //   ultimate- golden flying gunner with a white aura. Unlocks at 9000 pts.
  // ══════════════════════════════════════════════════════════════
  const ENEMY_SIZE = 34;
  const ENEMY_SIZE_BIG = ENEMY_SIZE * 2; // brute: 2×2 normal raiders

  const EnemyKind = {
    RAIDER: "raider",
    DROPPER: "dropper",
    GUNNER: "gunner",
    FLYER: "flyer",
    SPIKER: "spiker",
    BRUTE: "brute",
    FROST: "frost",
    LASER: "laser",
    SLIDER: "slider",
    COMMANDO: "commando",
    ULTIMATE: "ultimate",
  };

  /** @type {Record<string, {
   *   id: string,
   *   unlockScore: number,
   *   spawnWeight: number,
   *   lethalOnContact: boolean,
   *   canShoot: boolean,
   *   dropPowerup: string|null,
   *   size?: number,          // body px (defaults to ENEMY_SIZE)
   *   flying?: boolean,       // no gravity, hovers over gaps
   *   speedMul?: number,      // multiplier on the leftward approach speed
   *   beam?: boolean,         // charges and fires a low horizontal laser
   *   parachute?: boolean,    // drops in at a locked screen X, then walks
   *   spikes?: "toggle"|"always"|null, // head spikes block stomps while out
   *   fxColor: string,        // particle color prefix ("rgba(r, g, b,")
   *   hitReason: string,      // death message on lethal side contact
   *   label: string,
   *   name: string,
   *   desc: string,
   * }>} */
  const ENEMY_TYPES = {
    [EnemyKind.RAIDER]: {
      id: EnemyKind.RAIDER,
      unlockScore: 100,
      spawnWeight: 1.0,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      fxColor: "rgba(255, 80, 70,",
      hitReason: "A red ice raider crashed into you! Stomp from above or jump over.",
      label: "ice raider",
      name: "Ice Raider",
      desc: "Charges straight down the lane. <strong>Stomp it from above</strong> to squash it - any side bump is fatal. Hit <strong>{{JUMP}}</strong> as you land for a double-height boost jump.",
    },
    [EnemyKind.DROPPER]: {
      id: EnemyKind.DROPPER,
      unlockScore: 0,
      spawnWeight: 0.4,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: "random", // stomp grants a random id from POWERUP_DROP_IDS
      fxColor: "rgba(255, 210, 60,",
      hitReason: "You ran into a powerup dropper! Stomp from above next time for a powerup",
      label: "powerup dropper",
      name: "Powerup Dropper",
      desc: "A yellow <strong>?</strong> box. Stomp it and get a <strong>random powerup</strong>"
    },
    [EnemyKind.GUNNER]: {
      id: EnemyKind.GUNNER,
      unlockScore: 1000,
      spawnWeight: 0.35,
      lethalOnContact: true,
      canShoot: true,
      dropPowerup: null,
      fxColor: "rgba(255, 80, 70,",
      hitReason: "An armed ice raider got you! Stomp them from above - don't run into them.",
      label: "armed raider",
      name: "Gunner",
      desc: "An armed raider that <strong>fires at will</strong>. Jump the shots, then land on its head - or shoot back if you're carrying a gun.",
    },
    [EnemyKind.FLYER]: {
      id: EnemyKind.FLYER,
      unlockScore: 2000,
      spawnWeight: 0.4,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      flying: true,
      fxColor: "rgba(190, 120, 255,",
      hitReason: "A winged raider clipped you! They cruise over the gaps - stomp them out of the air.",
      label: "winged raider",
      name: "Winged Raider",
      desc: "Airborne. It <strong>glides over gaps</strong> instead of falling in. Still squashes if you land on its head.",
    },
    [EnemyKind.SPIKER]: {
      id: EnemyKind.SPIKER,
      unlockScore: 3000,
      spawnWeight: 0.3,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      spikes: "toggle",
      fxColor: "rgba(90, 180, 255,",
      hitReason: "The blue spiker got you! Watch its head - stomp only while the spikes are tucked in.",
      label: "spiker",
      name: "Blue Spiker",
      desc: "Head spikes that pop <strong>out for 1s, in for 1s</strong>. Land on it while they're <strong>out</strong> and you're done - time your stomp for the second they retract.",
    },
    [EnemyKind.BRUTE]: {
      id: EnemyKind.BRUTE,
      unlockScore: 4000,
      spawnWeight: 0.28,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      size: ENEMY_SIZE_BIG,
      fxColor: "rgba(120, 120, 140,",
      hitReason: "The black brute flattened you! It's twice the size - go over the top, never around.",
      label: "brute",
      name: "Black Brute",
      desc: "A slab of black ice <strong>twice as wide and twice as tall</strong> as a raider. Too big to jump clean, so land on its head instead.",
    },
    [EnemyKind.FROST]: {
      id: EnemyKind.FROST,
      unlockScore: 5000,
      spawnWeight: 0.26,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      spikes: "always",
      fxColor: "rgba(225, 240, 255,",
      hitReason: "The white spiker got you! Its spikes never retract - you cannot stomp that one.",
      label: "white spiker",
      name: "White Spiker",
      desc: "Bone-white, with spikes that <strong>never retract</strong>. There is <strong>no stomping this one</strong> - jump it clean or shoot it with the gun.",
    },
    [EnemyKind.LASER]: {
      id: EnemyKind.LASER,
      unlockScore: 6000,
      spawnWeight: 0.9,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      beam: true,
      fxColor: "rgba(255, 90, 210,",
      hitReason: "The lazer raider cut you down! The beam runs along the ice - be in the air when it fires.",
      label: "lazer raider",
      name: "Lazer Raider",
      desc: "Winds up a <strong>magenta beam</strong> - the emitter glows and an aim line snaps out, then it fires along the ice for a split second. It only ever sweeps low, so <strong>jump and it passes under you</strong>.",
    },
    [EnemyKind.SLIDER]: {
      id: EnemyKind.SLIDER,
      unlockScore: 7000,
      spawnWeight: 0.9,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      speedMul: 2,
      fxColor: "rgba(120, 240, 255,",
      hitReason: "An ice raider skated into you! They close twice as fast as the red ones - react early.",
      label: "ice raider",
      name: "Ice Raider",
      desc: "Skates in at <strong>double the usual speed</strong> on a spray of frost. Same stomp, far less time to set it up - commit to the jump the moment you see the streak.",
    },
    [EnemyKind.COMMANDO]: {
      id: EnemyKind.COMMANDO,
      unlockScore: 8000,
      spawnWeight: 0.9,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: null,
      parachute: true,
      fxColor: "rgba(150, 190, 120,",
      hitReason: "A commando raider dropped on your head! Watch the sky once the chutes start falling.",
      label: "commando raider",
      name: "Commando Raider",
      desc: "Drops out of the sky under a parachute with a <strong>knife in its teeth</strong>, holding its spot on screen while the ice runs past beneath it. <strong>Stomp it in mid-air</strong> or clear the patch of ice it is aiming for.",
    },
    [EnemyKind.ULTIMATE]: {
      id: EnemyKind.ULTIMATE,
      unlockScore: 9000,
      spawnWeight: 1.1,
      lethalOnContact: true,
      canShoot: true,
      dropPowerup: null,
      flying: true,
      fxColor: "rgba(255, 215, 90,",
      hitReason: "The Ultimate Raider ended your run. Gold, airborne and armed - stomp it or stay clear.",
      label: "ultimate raider",
      name: "Ultimate Raider",
      desc: "The last thing between you and 10,000. It <strong>flies, it shines gold and it shoots</strong>, with white burning eyes and an aura around it. Jump the shots and land on its crown.",
    },
  };

  /**
   * Static level hazards, listed in the manual next to the enemies.
   * icon = key handled by drawManualIcon(); no gameplay data lives here.
   */
  const HAZARD_INFO = [
    {
      icon: "gap",
      name: "The Gap",
      tag: "300+ pts",
      desc: "Missing ice. Time your <strong>{{JUMP}}</strong> or you slide straight into the abyss. The first 300 points are one unbroken runway - the ice only starts breaking up after that.",
    },
    {
      icon: "spike",
      name: "Ice Spikes",
      tag: "always",
      desc: "Frozen shards planted in the slab. Jump them clean or get impaled.",
    },
    {
      icon: "crate",
      name: "Ice Crate",
      tag: "always",
      desc: "A solid block parked on the track. <strong>Stomp it from above</strong> to shatter it, hit it from the side and the run is over.",
    },
  ];

  const ENEMY_SPAWN_MIN = 1.4;
  const ENEMY_SPAWN_MAX = 2.8;
  const ENEMY_APPROACH = 90; // extra leftward speed (world units/sec)
  /**
   * Flyer cruise altitude, measured from the ice to the enemy's feet.
   * Its head must stay inside the jump budget or it becomes an unstompable,
   * unjumpable wall: ENEMY_SIZE + FLY_HOVER_MAX + FLY_BOB < JUMP_HEIGHT (118).
   */
  const FLY_HOVER_MIN = 38;
  const FLY_HOVER_MAX = 60;
  const FLY_BOB = 5; // vertical sine amplitude (moves the hitbox with the art)
  /** Spiker: 1s out, 1s in, with a short ramp so the pop reads. */
  const SPIKE_CYCLE = 2;
  const SPIKE_RAMP = 0.15;

  /**
   * Lazer raider. The beam itself only lives for BEAM seconds, which is far
   * too short to react to - so the reaction is sold on the CHARGE instead:
   * the emitter spins up and an aim line snaps out along the firing line, and
   * that is the cue to jump. The beam is the punishment, not the warning.
   *
   * The beam runs at the enemy's own mid-height (~17px over the ice), so its
   * top edge sits far under the 118px jump apex - being airborne always clears
   * it, which is the whole contract with the player.
   */
  const LASER_CHARGE = 0.9;
  const LASER_BEAM = 0.1; // 100ms, as specified
  const LASER_RELOAD_MIN = 1.6;
  const LASER_RELOAD_MAX = 2.6;
  /**
   * The wind-up has to start the moment the raider clears the right edge, and
   * that is not a detail. It gets only (W + 60 - PLAYER_X + 40) / (MAX_SPEED +
   * approach) ≈ 1.5s on screen before it reaches the player, and the charge
   * eats 0.9s of that; a full LASER_RELOAD_* up front left barely a quarter of
   * lazer raiders ever firing a beam (measured over ~175 spawns). With the
   * short first shot plus the solid-ice placement in findBeamFooting() it is
   * about half - the rest fall into gaps mid-charge, same as any ground enemy.
   *
   * One telegraphed shot per pass is the whole enemy; LASER_RELOAD_* only
   * matters if it somehow lives long enough for a second.
   */
  const LASER_FIRST_SHOT_MIN = 0.05;
  const LASER_FIRST_SHOT_MAX = 0.25;
  const LASER_RANGE = 1500; // world units of beam, fired back down the lane
  const LASER_THICKNESS = 9;

  /** Commando: descent rate while under the chute (world units/sec). */
  const CHUTE_FALL_SPEED = 62;
  const CHUTE_SPAWN_Y = -70;

  /** Ultimate raider: cruises a little higher than a flyer, still stompable. */
  const ULTIMATE_HOVER_MIN = 44;
  const ULTIMATE_HOVER_MAX = 64;
  const BULLET_SPEED = 320;
  const SHOOT_COOLDOWN = 1.35;
  const STOMP_BOUNCE = JUMP_VELOCITY * 0.42; // hop after squashing a raider
  // Timed Space on stomp: apex height = 2× normal jump when held (v ∝ √height)
  const STOMP_BOOST_VELOCITY = JUMP_VELOCITY * Math.SQRT2;
  const STOMP_JUMP_GRACE = 0.1; // late Space still counts right after squash

  // ══════════════════════════════════════════════════════════════
  // POWERUP SYSTEM (scalable)
  // ──────────────────────────────────────────────────────────────
  // HOW TO ADD A NEW POWERUP (for future agents):
  //   1. Add an id string (e.g. "magnet") and register it in POWERUP_DEFS.
  //   2. Fields:
  //        duration   - seconds active (0 = until consumed / permanent flag)
  //        warnAt     - start blinking when remaining ≤ this many seconds
  //        absorbHit  - if true, one lethal contact is blocked and the
  //                     powerup is removed (see tryAbsorbHit)
  //        exclusive  - if true, granting replaces any other exclusive buffs
  //        onGrant / onExpire / onUpdate - optional lifecycle hooks
  //        draw(ctx, player, state) - optional overlay while active
  //        name / desc - copy for the Instructions screen, which is built
  //                     straight from this table (its icon is the player
  //                     sprite wearing the powerup, so no extra art needed)
  //   3. Add the id to POWERUP_DROP_IDS so droppers can grant it (equal weight).
  //   4. Grant with grantPowerup("id"). Runtime state lives in activePowerups.
  //   5. Lethal contacts should call playerTakeHit(reason) so absorbHit works.
  //
  // Current powerups:
  //   shield - bubble, 10s, pops on first hit, blinks in last 2s.
  //   wings  - held until used; SPACE in air = one extra jump, then wings pop.
  //   gun    - 10s, auto-shoots on-screen enemies ahead, blinks in last 2s.
  //   bridge - held until used; next gap fall deploys a bridge under the player.
  // ══════════════════════════════════════════════════════════════
  const POWERUP_DEFS = {
    shield: {
      id: "shield",
      duration: 10,
      warnAt: 2, // blink when ≤ 2s left (i.e. after 8s of the 10s)
      absorbHit: true,
      exclusive: false,
      label: "Shield",
      name: "Shield",
      desc: "A bubble for <strong>10s</strong> that eats <strong>one lethal hit</strong>, then pops. It blinks for the last 2 seconds - that's your cue.",
    },
    wings: {
      id: "wings",
      duration: 0, // until used (double-jump)
      warnAt: 0,
      absorbHit: false,
      exclusive: false,
      label: "Wings",
      name: "Wings",
      desc: "Kept until you spend them. Use <strong>{{JUMP}} in mid-air</strong> for one extra jump - then the wings burst into feathers.",
    },
    gun: {
      id: "gun",
      duration: 10,
      warnAt: 2,
      absorbHit: false,
      exclusive: false,
      label: "Gun",
      name: "Gun",
      desc: "<strong>10s</strong> of auto-fire at anything on screen ahead of you. Blinks for the last 2 seconds before it's gone.",
    },
    bridge: {
      id: "bridge",
      duration: 0, // until used (next gap)
      warnAt: 0,
      absorbHit: false,
      exclusive: false,
      label: "Bridge",
      name: "Bridge",
      desc: "Held until the moment you need it: the <strong>next gap you fall into</strong> gets a plank bridge and you slide right across.",
    },
  };

  /** Equal-weight pool granted when a dropper is stomped. */
  const POWERUP_DROP_IDS = ["shield", "wings", "gun", "bridge"];

  const GUN_FIRE_INTERVAL = 0.28;
  const GUN_SIGHT_Y = 110;
  const PLAYER_BULLET_SPEED = 560;

  // ══════════════════════════════════════════════════════════════
  // SKINS (cosmetic only)
  // ──────────────────────────────────────────────────────────────
  // HOW TO ADD A SKIN (for future agents):
  //   1. Register an entry in SKIN_DEFS and add its id to SKIN_ORDER.
  //      The Skins screen is generated straight from that table, and the
  //      card preview is the real sprite - there is no second art path.
  //   2. Art hooks run inside drawPlayer's transform, so the origin is the
  //      square's centre and the box is w × h (always PLAYER_SIZE):
  //        behind(w, h, t)   - drawn under the body (tails, glow)
  //        body(w, h, t)     - the square itself
  //        features(w, h, t) - horns, tape, pips… drawn over the body
  //        eyes              - false to suppress the default pair
  //      t is seconds (performance.now() / 1000) - animate off it freely.
  //      None of the three run on the death frame: a dead square is always
  //      the plain red one, because that colour is a gameplay signal.
  //   3. trail  - the colour of the speed streaks behind the square.
  //      accent - drives the card's glow / equipped ring in the shop.
  //   4. NOTHING a skin draws may touch player.w / player.h. The hitbox is
  //      PLAYER_SIZE for every skin; horns and tails are pure decoration.
  //   5. Keep animation state in skinAnim, never on `player`, and never push
  //      cosmetic sparkles into `particles` - that array reads as gameplay.
  //
  // Palette rule: enemies own red, yellow, purple, blue, black and white,
  // and the death tint owns salmon. Stay out of those or the player will
  // lose track of their own square at 400 units/sec.
  // ══════════════════════════════════════════════════════════════

  /** Per-skin animation state - deliberately separate from `player`. */
  const skinAnim = {
    /** Lucky Dice: the settled face, and when the tumble ends (ms). */
    diceFace: 5,
    diceRollUntil: 0,
  };

  function rollDice() {
    skinAnim.diceRollUntil = performance.now() + 260;
    skinAnim.diceFace = 4 + Math.floor(Math.random() * 3); // it never rolls low
  }

  /** Every jump rerolls the die. Cosmetic - no gameplay reads this. */
  function skinOnJump() {
    if (equippedSkin === "dice") rollDice();
  }

  const SKIN_DEFS = {
    classic: {
      id: "classic",
      name: "Classic",
      tag: "Original",
      blurb: "The green cube that started the whole sliding problem.",
      accent: "#3dd68c",
      trail: "#3dd68c",
      body(w, h) {
        const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        g.addColorStop(0, "#7aefc0");
        g.addColorStop(0.5, "#3dd68c");
        g.addColorStop(1, "#1faa68");
        roundRect(-w / 2, -h / 2, w, h, 6);
        ctx.fillStyle = g;
        ctx.fill();
        skinShine(w, h);
      },
    },

    hornhead: {
      id: "hornhead",
      name: "Hornhead",
      tag: "Mischief",
      blurb: "Tiny horns, permanent smirk. The ice gets a little damp underneath.",
      accent: "#ff5ec8",
      trail: "#ea3fb0",
      behind(w, h, t) {
        // Forked tail, flicking against the run
        const wag = Math.sin(t * 5) * 3;
        const tipX = -w / 2 - 11;
        const tipY = -1 + wag;
        ctx.strokeStyle = "#c2318f";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 4, 9);
        ctx.quadraticCurveTo(-w / 2 - 13, 12 + wag, tipX, tipY);
        ctx.stroke();
        // Spade tip, sitting on the end of the curve
        ctx.fillStyle = "#c2318f";
        ctx.beginPath();
        ctx.moveTo(tipX + 0.5, tipY - 7.5);
        ctx.lineTo(tipX - 4, tipY + 1.5);
        ctx.lineTo(tipX + 5, tipY + 1.5);
        ctx.closePath();
        ctx.fill();
      },
      body(w, h) {
        const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        g.addColorStop(0, "#ff9ce0");
        g.addColorStop(0.5, "#ea3fb0");
        g.addColorStop(1, "#8f1f6e");
        roundRect(-w / 2, -h / 2, w, h, 6);
        ctx.fillStyle = g;
        ctx.fill();
        skinShine(w, h);
      },
      features(w, h) {
        drawImpHorn(-1, h);
        drawImpHorn(1, h);
        // Angry brows over the standard eyes
        ctx.strokeStyle = "#3a1030";
        ctx.lineWidth = 2.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0.5, -10.5);
        ctx.lineTo(7, -8);
        ctx.moveTo(18, -10.5);
        ctx.lineTo(11.5, -8);
        ctx.stroke();
        // Smirk with one fang
        ctx.strokeStyle = "rgba(58, 16, 48, 0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(9, 3, 5.5, 0.15, Math.PI * 0.82);
        ctx.stroke();
        ctx.fillStyle = "#fff6fb";
        ctx.beginPath();
        ctx.moveTo(11, 6.5);
        ctx.lineTo(14, 6.5);
        ctx.lineTo(12.5, 10.5);
        ctx.closePath();
        ctx.fill();
      },
    },

    boxed: {
      id: "boxed",
      name: "Boxed In",
      tag: "Stealth",
      blurb: "Nobody suspects a cardboard box. Nobody has ever suspected a box.",
      accent: "#d8a566",
      trail: "#b5793c",
      body(w, h, t) {
        const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        g.addColorStop(0, "#e0b075");
        g.addColorStop(0.55, "#b5793c");
        g.addColorStop(1, "#7d4a1f");
        roundRect(-w / 2, -h / 2, w, h, 4);
        ctx.fillStyle = g;
        ctx.fill();

        ctx.save();
        roundRect(-w / 2, -h / 2, w, h, 4);
        ctx.clip();

        // Folded-over lid: a lighter band across the top, creased in the middle
        ctx.fillStyle = "rgba(255, 226, 178, 0.22)";
        ctx.fillRect(-w / 2, -h / 2, w, 9);
        ctx.strokeStyle = "rgba(107, 63, 24, 0.55)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, -h / 2 + 9);
        ctx.lineTo(w / 2, -h / 2 + 9);
        ctx.stroke();
        // The corrugated edge shows in the crease
        ctx.strokeStyle = "rgba(107, 63, 24, 0.3)";
        ctx.lineWidth = 1;
        for (let x = -w / 2 + 3; x < w / 2; x += 4) {
          ctx.beginPath();
          ctx.moveTo(x, -h / 2 + 5.5);
          ctx.lineTo(x, -h / 2 + 9);
          ctx.stroke();
        }
        // Packing tape down the seam - glossy, slightly wrinkled
        const tape = ctx.createLinearGradient(-5, 0, 5, 0);
        tape.addColorStop(0, "rgba(255, 243, 214, 0.2)");
        tape.addColorStop(0.4, "rgba(255, 246, 222, 0.46)");
        tape.addColorStop(1, "rgba(214, 190, 145, 0.28)");
        ctx.fillStyle = tape;
        ctx.fillRect(-5, -h / 2 + 9, 10, h);
        // Stamped "this way up" arrow, printed slightly crooked
        ctx.save();
        ctx.translate(w / 2 - 8, h / 2 - 9);
        ctx.rotate(-0.18);
        ctx.strokeStyle = "rgba(178, 54, 42, 0.65)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, 4.5);
        ctx.lineTo(0, -4);
        ctx.moveTo(-3.2, -1);
        ctx.lineTo(0, -4.5);
        ctx.lineTo(3.2, -1);
        ctx.stroke();
        ctx.restore();
        // Scuffed corner, because this box has been through things
        ctx.fillStyle = "rgba(94, 55, 22, 0.22)";
        ctx.beginPath();
        ctx.moveTo(-w / 2, h / 2 - 9);
        ctx.lineTo(-w / 2 + 9, h / 2);
        ctx.lineTo(-w / 2, h / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      },
      features(w, h, t) {
        // Two eye-holes cut in the front, with something glowing inside
        ctx.fillStyle = "#241304";
        roundRect(0.5, -8, 8, 7, 2.5);
        ctx.fill();
        roundRect(11.5, -8, 8, 7, 2.5);
        ctx.fill();
        const blink = Math.sin(t * 1.7) > 0.985 ? 0.15 : 1;
        ctx.fillStyle = `rgba(255, 240, 190, ${0.95 * blink})`;
        ctx.beginPath();
        ctx.arc(5.4, -4.4, 2 * blink + 0.6, 0, Math.PI * 2);
        ctx.arc(16.4, -4.4, 2 * blink + 0.6, 0, Math.PI * 2);
        ctx.fill();
      },
      eyes: false,
    },

    disco: {
      id: "disco",
      name: "Disco Cube",
      tag: "Groovy",
      blurb: "Mirror tiles on all six faces. Zero extra grip, infinite extra sparkle.",
      accent: "#c9a6ff",
      trail: "#cfe6ff",
      body(w, h, t) {
        const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        g.addColorStop(0, "#f2f7ff");
        g.addColorStop(0.5, "#a8bcd4");
        g.addColorStop(1, "#5d7089");
        roundRect(-w / 2, -h / 2, w, h, 6);
        ctx.fillStyle = g;
        ctx.fill();

        ctx.save();
        roundRect(-w / 2, -h / 2, w, h, 6);
        ctx.clip();

        // Dark grout, so the tiles read as separate mirrors and not a quilt
        ctx.fillStyle = "#1d2735";
        ctx.fillRect(-w / 2, -h / 2, w, h);

        // Mirror tiles, each catching a different colour of the room
        const n = 5;
        const cell = w / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const hue = (i * 47 + j * 83 + t * 90) % 360;
            const lift = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 1.3 + j * 0.7);
            const x = -w / 2 + i * cell;
            const y = -h / 2 + j * cell;
            ctx.fillStyle = `hsl(${hue}, 72%, ${40 + lift * 34}%)`;
            ctx.fillRect(x + 0.9, y + 0.9, cell - 1.8, cell - 1.8);
            // Each tile keeps a hard corner glint
            ctx.fillStyle = `rgba(255,255,255,${0.1 + lift * 0.4})`;
            ctx.fillRect(x + 0.9, y + 0.9, cell * 0.42, cell * 0.42);
          }
        }
        // Specular sweep across the facets
        const sweep = ((t * 0.55) % 1) * (w * 2) - w;
        const sg = ctx.createLinearGradient(sweep - 9, 0, sweep + 9, 0);
        sg.addColorStop(0, "rgba(255,255,255,0)");
        sg.addColorStop(0.5, "rgba(255,255,255,0.55)");
        sg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sg;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
      },
      features(w, h, t) {
        // Stray light beams flicking off the mirror tiles
        for (let i = 0; i < 3; i++) {
          const p = (t * 0.8 + i * 0.37) % 1;
          const ang = i * 2.1 + t * 1.4;
          const r = w * 0.42 + p * 12;
          const a = Math.sin(p * Math.PI) * 0.85;
          if (a <= 0.02) continue;
          drawSparkStar(
            Math.cos(ang) * r,
            Math.sin(ang) * r * 0.8,
            3 + p * 3,
            `hsla(${(i * 120 + t * 140) % 360}, 100%, 75%, ${a})`
          );
        }
      },
    },

    dice: {
      id: "dice",
      name: "Lucky Dice",
      tag: "Chancy",
      blurb: "Rerolls on every jump and has never once landed under a four. Weighted? Rude.",
      accent: "#f0dfae",
      trail: "#efe4c6",
      body(w, h) {
        const g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        g.addColorStop(0, "#fffdf3");
        g.addColorStop(0.55, "#f2e6c8");
        g.addColorStop(1, "#cfba8e");
        roundRect(-w / 2, -h / 2, w, h, 9);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = "rgba(120, 100, 62, 0.4)";
        ctx.lineWidth = 1;
        roundRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, 8.5);
        ctx.stroke();
        skinShine(w, h);
      },
      features(w) {
        const now = performance.now();
        // Mid-tumble the face flickers, then it settles on the rolled value
        const face =
          now < skinAnim.diceRollUntil
            ? 4 + (Math.floor(now / 55) % 3)
            : skinAnim.diceFace;
        const o = w * 0.26;
        const pips = DICE_PIPS[face] || DICE_PIPS[5];
        ctx.fillStyle = "#2a2621";
        for (const [px, py] of pips) {
          ctx.beginPath();
          ctx.arc(px * o, py * o, 3.1, 0, Math.PI * 2);
          ctx.fill();
        }
        // The two top pips double as eyes - the die is watching you
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.arc(-o - 0.9, -o - 0.9, 1.1, 0, Math.PI * 2);
        ctx.arc(o - 0.9, -o - 0.9, 1.1, 0, Math.PI * 2);
        ctx.fill();
      },
      eyes: false,
    },
  };

  /** Card order in the shop. Classic first - it's the way home. */
  const SKIN_ORDER = ["classic", "hornhead", "boxed", "disco", "dice"];

  /** Pip layout in units of a quarter-square, for the faces the die rolls. */
  const DICE_PIPS = {
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
  };

  // Membership via SKIN_ORDER, not SKIN_DEFS - a stored "toString" would
  // otherwise pass the check and hand activeSkin() a prototype method.
  const savedSkin = localStorage.getItem("iceSlideSkin");
  let equippedSkin = SKIN_ORDER.includes(savedSkin) ? savedSkin : "classic";

  /** Set while a shop card paints its preview, so cards show their own skin. */
  let previewSkin = null;

  function activeSkin() {
    return SKIN_DEFS[previewSkin] || SKIN_DEFS[equippedSkin] || SKIN_DEFS.classic;
  }

  function equipSkin(id) {
    if (!SKIN_ORDER.includes(id)) return;
    equippedSkin = id;
    try {
      localStorage.setItem("iceSlideSkin", id);
    } catch (err) {
      /* private browsing - the choice just won't survive a reload */
    }
  }

  /** The diagonal glare every hard-surfaced skin shares. */
  function skinShine(w, h) {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    roundRect(-w / 2 + 4, -h / 2 + 4, w * 0.45, 8, 3);
    ctx.fill();
  }

  /** One curved imp horn - thick at the skull, hooking out to a point. */
  function drawImpHorn(dir, h) {
    const top = -h / 2;
    const g = ctx.createLinearGradient(dir * 2, top - 13, dir * 12, top + 2);
    g.addColorStop(0, "#f0e2d4");
    g.addColorStop(0.45, "#8d7580");
    g.addColorStop(1, "#2c1c28");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(dir * 2.5, top + 2);
    ctx.quadraticCurveTo(dir * 3.5, top - 11, dir * 14.5, top - 13.5);
    ctx.quadraticCurveTo(dir * 10, top - 6.5, dir * 11.5, top + 2);
    ctx.closePath();
    ctx.fill();
    // Ridge highlight along the leading edge
    ctx.strokeStyle = "rgba(255, 240, 250, 0.35)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(dir * 4.5, top + 1);
    ctx.quadraticCurveTo(dir * 5.5, top - 9, dir * 13, top - 12);
    ctx.stroke();
  }

  /** A four-pointed sparkle - used for skin glints only, never gameplay. */
  function drawSparkStar(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.quadraticCurveTo(x, y, x - r, y);
    ctx.quadraticCurveTo(x, y, x, y - r);
    ctx.fill();
  }

  // ══════════════════════════════════════════════════════════════
  // SHOP (run modifiers — free, and they switch the score off)
  // ──────────────────────────────────────────────────────────────
  // HOW TO ADD A SHOP ITEM (for future agents):
  //   1. Register an entry in SHOP_DEFS and add its id to SHOP_ORDER.
  //      The Shop screen is generated straight from that table - card,
  //      icon and copy - exactly like the manual and the wardrobe.
  //   2. group: "start" items are a head start and are mutually exclusive
  //      (one per run); "mod" items stack freely.
  //   3. icon(S) paints the card tile with the game's own draw functions.
  //      There is no second art path in this file and this is no exception.
  //   4. Read it from gameplay with shopOn("id") - nothing outside this
  //      block may touch shopEquipped directly.
  //   5. Anything equipped turns the run into a practice run: startGame()
  //      raises `warped`, which is the single flag that suppresses the
  //      best-score write in both die() and winRun(). A new item needs no
  //      extra wiring to be honest about that.
  // ══════════════════════════════════════════════════════════════
  const STEEL_HP = 10;

  /** Head-start rungs - one card per 1,000 up to the last one before the end. */
  const HEADSTART_STEPS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];

  const SHOP_DEFS = {};
  const SHOP_ORDER = [];

  for (const value of HEADSTART_STEPS) {
    const id = `start${value}`;
    SHOP_ORDER.push(id);
    SHOP_DEFS[id] = {
      id,
      group: "start",
      headstart: value,
      accent: "#ffd060",
      name: value.toLocaleString("en-US"),
      full: `Start at ${value.toLocaleString("en-US")}`,
      blurb: `Drop in at the ${value.toLocaleString("en-US")} mark, at the speed the run would already be doing.`,
    };
  }

  for (const def of [
    {
      id: "nogaps",
      accent: "#7fdcff",
      name: "No Gaps",
      tag: "Solid ice",
      blurb:
        "No more abyss to fall into, ice is solid throughout the run",
    },
    {
      id: "dropper2",
      accent: "#ffc820",
      name: "Double Droppers",
      tag: "×2 chance",
      blurb:
        "Twice as many powerup droppers come down the lane.",
    },
    {
      id: "steel",
      accent: "#c2ccd8",
      name: "Made of Steel",
      tag: "10 hit points",
      blurb:
        "Ten hit points of shell. Every bump cracks it a little and destroys whatever you hit. Falling into the abyss still end the run.",
    },
    {
      id: "forevergun",
      accent: "#ff9a4a",
      name: "Forever Gun",
      tag: "Never expires",
      blurb:
        "Forever gun, forever fun.",
    },
    {
      id: "fly",
      accent: "#c8b4ff",
      name: "Fly",
      tag: "Always double",
      blurb:
        "A second jump is always in your pocket",
    },
  ]) {
    SHOP_ORDER.push(def.id);
    SHOP_DEFS[def.id] = { ...def, group: "mod" };
  }

  const SHOP_STORAGE_KEY = "iceSlideShop";

  /**
   * Ids the player has equipped. Membership is validated against SHOP_ORDER,
   * not SHOP_DEFS - a hand-edited "toString" in storage would otherwise pass
   * a plain `in` check and hand the loadout a prototype method.
   */
  const shopEquipped = new Set(loadShopLoadout());

  function loadShopLoadout() {
    let ids = [];
    try {
      const raw = JSON.parse(localStorage.getItem(SHOP_STORAGE_KEY) || "[]");
      if (Array.isArray(raw)) ids = raw.filter((id) => SHOP_ORDER.includes(id));
    } catch (err) {
      /* corrupt or unreadable - start the shop empty */
    }
    // Storage could carry two head starts; the run can only honour one.
    let seenStart = false;
    return ids.filter((id) => {
      if (SHOP_DEFS[id].group !== "start") return true;
      if (seenStart) return false;
      seenStart = true;
      return true;
    });
  }

  function saveShopLoadout() {
    try {
      localStorage.setItem(SHOP_STORAGE_KEY, JSON.stringify([...shopEquipped]));
    } catch (err) {
      /* private browsing - the loadout just won't survive a reload */
    }
  }

  /** The only way gameplay is allowed to ask about the shop. */
  function shopOn(id) {
    return shopEquipped.has(id);
  }

  /** True when the run is modified, i.e. when the score must not count. */
  function shopModified() {
    return shopEquipped.size > 0;
  }

  /** The equipped head start in points, or 0 for an honest opening. */
  function shopHeadstart() {
    for (const id of shopEquipped) {
      const def = SHOP_DEFS[id];
      if (def && def.group === "start") return def.headstart;
    }
    return 0;
  }

  function toggleShopItem(id) {
    const def = SHOP_DEFS[id];
    if (!def) return;
    if (shopEquipped.has(id)) {
      shopEquipped.delete(id);
    } else {
      // One head start per run - taking a new rung drops the old one.
      if (def.group === "start") {
        for (const other of [...shopEquipped]) {
          if (SHOP_DEFS[other].group === "start") shopEquipped.delete(other);
        }
      }
      shopEquipped.add(id);
    }
    saveShopLoadout();
  }

  function clearShopLoadout() {
    shopEquipped.clear();
    saveShopLoadout();
  }

  // ── Environment themes (cycle every 1000 pts) ─────────────────
  const THEMES = [
    {
      name: "Midnight Ice",
      sky: ["#0d1b2e", "#12263d", "#0a1828"],
      mountain: "rgba(30, 55, 80, 0.55)",
      snowCap: "rgba(180, 210, 230, 0.25)",
      aurora: ["rgba(60, 200, 160, 0)", "rgba(60, 200, 180, 0.08)", "rgba(80, 140, 255, 0.1)"],
      iceTop: "#c8e8ff",
      iceMid: "#7eb8d8",
      iceDeep: "#1a3a55",
    },
    {
      name: "Aurora Bloom",
      sky: ["#0a1a2e", "#12304a", "#0c2030"],
      mountain: "rgba(25, 70, 90, 0.55)",
      snowCap: "rgba(160, 255, 220, 0.28)",
      aurora: ["rgba(40, 255, 180, 0)", "rgba(40, 255, 200, 0.14)", "rgba(120, 80, 255, 0.16)"],
      iceTop: "#c0fff0",
      iceMid: "#5ec8b0",
      iceDeep: "#0e3a40",
    },
    {
      name: "Twilight Frost",
      sky: ["#1a1230", "#2a1848", "#120c22"],
      mountain: "rgba(55, 35, 80, 0.55)",
      snowCap: "rgba(230, 190, 255, 0.28)",
      iceTop: "#e0d0ff",
      iceMid: "#9a80c8",
      iceDeep: "#2a1a45",
      aurora: ["rgba(200, 80, 255, 0)", "rgba(255, 100, 180, 0.12)", "rgba(100, 120, 255, 0.14)"],
    },
    {
      name: "Polar Dawn",
      sky: ["#1a2035", "#3a2840", "#1a1525"],
      mountain: "rgba(70, 45, 55, 0.55)",
      snowCap: "rgba(255, 210, 180, 0.3)",
      aurora: ["rgba(255, 160, 80, 0)", "rgba(255, 140, 100, 0.12)", "rgba(255, 90, 140, 0.1)"],
      iceTop: "#ffe8d8",
      iceMid: "#d0a090",
      iceDeep: "#3a2830",
    },
    {
      name: "Deep Night",
      sky: ["#050a14", "#0a1528", "#040810"],
      mountain: "rgba(15, 30, 50, 0.65)",
      snowCap: "rgba(140, 180, 220, 0.2)",
      aurora: ["rgba(40, 80, 200, 0)", "rgba(60, 100, 255, 0.1)", "rgba(20, 200, 255, 0.08)"],
      iceTop: "#a8c8e8",
      iceMid: "#4a7090",
      iceDeep: "#0a2030",
    },
  ];

  // ── State ─────────────────────────────────────────────────────
  const State = {
    MENU: "menu",
    PLAYING: "playing",
    DEAD: "dead",
    VICTORY: "victory",
  };

  let state = State.MENU;

  /**
   * Which front-end screen owns the input right now.
   * "home" = entrance screen · "instructions" = field manual · null = in the run.
   */
  let menuView = "home";

  let lastTime = 0;
  let score = 0;
  let best = Number(localStorage.getItem("iceSlideBest") || 0);
  /** Set by the 1–5 warp shortcut - such a run never writes the saved best. */
  let warped = false;
  let runTime = 0;
  let speed = BASE_SPEED;
  let distance = 0;
  let shake = 0;
  let particles = [];
  let snowflakes = [];
  let fireworks = [];

  /** Milestone signs every 100 pts - on ice, or floating in a bubble over a gap */
  /** @type {{x:number,value:number,floating:boolean,bob:number}[]} */
  let signs = [];
  let nextSignValue = SIGN_INTERVAL;

  /**
   * Live enemy instances. baseY is the flyer's cruise line; spikeT drives the
   * spiker's out/in cycle (see enemySpikeExtend).
   * @type {{type:string,x:number,y:number,w:number,h:number,vy:number,bob:number,
   *   shootCd:number,baseY:number,spikeT:number}[]}
   */
  let enemies = [];
  let enemySpawnTimer = 0;

  /** Enemy projectiles (world space) */
  /** @type {{x:number,y:number,vx:number,vy:number,r:number}[]} */
  let bullets = [];

  /**
   * Active powerups on the player.
   * Map keyed by powerup id → { id, remaining, def }
   * @type {Map<string, {id:string, remaining:number, def:object}>}
   */
  let activePowerups = new Map();

  /** Brief invulnerability after a shield pop so the same hazard doesn't re-kill. */
  let hitInvuln = 0;

  /**
   * Made of Steel (shop): hit points left in the shell, 0 when the mod is off.
   * Deliberately not a powerup - warpToScore() clears powerups mid-run and a
   * shop mod has to outlive that.
   */
  let steelHp = 0;
  /** Seconds of white flash left on the shell after a crack. */
  let steelFlash = 0;

  let themeIndex = 0;
  let themeBlend = 1; // 0..1 blend into current theme
  let lastThemeTier = 0;
  let fireworksQueue = 0;

  // ── Victory (the 10,000 finale) ───────────────────────────────
  /** Seconds since the run was won. Drives the whole celebration. */
  let victoryT = 0;
  /** Screen Y of the THANK YOU banner as it drops in. */
  let victoryTitleY = VICTORY_TITLE_START;
  /** True once the banner has touched down - only then does SPACE restart. */
  let victoryTitleLanded = false;
  let victoryDropTimer = 0;
  /**
   * Purely decorative raiders raining out of the sky and shattering. They are
   * not enemies: no collision, no registry entry, they only borrow the art.
   * @type {{type:string,x:number,y:number,vy:number,size:number,rot:number,
   *   spin:number,burstY:number}[]}
   */
  let victoryDrops = [];

  const player = {
    x: PLAYER_X,
    y: GROUND_Y - PLAYER_SIZE,
    w: PLAYER_SIZE,
    h: PLAYER_SIZE,
    vy: 0,
    onGround: true,
    coyote: 0,
    jumpBuffer: 0,
    squish: 1, // visual squash factor
    rotation: 0,
    dead: false,
    stompJumpGrace: 0, // window after stomp to still land a boost jump
  };

  /** @type {{x:number,w:number,y:number,h:number}[]} */
  let platforms = [];
  /** @type {{x:number,y:number,w:number,h:number,type:string}[]} */
  let obstacles = [];

  // ══════════════════════════════════════════════════════════════
  // RESPONSIVE / VIEWPORT
  // ──────────────────────────────────────────────────────────────
  // One source of truth for "what kind of device is this" - JS owns the
  // media queries and stamps three classes on <body>; style.css only ever
  // reads those classes, so the two can never drift apart:
  //
  //   .is-touch            coarse pointer
  //   .is-portrait-locked  coarse + portrait → rotate gate up, sim frozen
  //   .is-fullscreen       coarse + landscape → game owns the viewport
  //
  // .is-running is stamped alongside by the state transitions.
  // ══════════════════════════════════════════════════════════════
  const mqCoarse = window.matchMedia("(pointer: coarse)");
  const mqPortrait = window.matchMedia("(orientation: portrait)");

  let isTouch = false;
  let portraitLocked = false;
  /** A run is frozen and waiting for a deliberate tap before it resumes. */
  let awaitingResume = false;

  /**
   * Match the backing store to the box we're painting into.
   * H never moves; W tracks the viewport aspect (clamped) so a landscape
   * phone gets a genuinely wide playfield instead of a letterboxed 900×400.
   */
  function layout() {
    let logical = BASE_W;
    if (document.body.classList.contains("is-fullscreen")) {
      // Measure the viewport, never the wrapper: the wrapper is sized from
      // --play-aspect below, so reading it back here would be a feedback loop.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw > 0 && vh > 0) logical = Math.round(H * (vw / vh));
    }
    W = Math.max(MIN_W, Math.min(MAX_W, logical));
    SPAWN_AHEAD = W + 200;
    // The wrapper takes the playfield's exact shape, so the menu, the HUD,
    // the game-over panel and the pause card all sit over the game rather
    // than over letterbox bars when the aspect lands outside the clamp.
    gameWrap.style.setProperty("--play-aspect", String(W / H));

    renderScale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const bw = Math.round(W * renderScale);
    const bh = Math.round(H * renderScale);
    // Assigning either dimension wipes the whole 2D state, so only do it
    // when something actually changed - and re-apply the transform in draw().
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
  }

  function applyViewportMode() {
    isTouch = mqCoarse.matches;
    const nowLocked = isTouch && mqPortrait.matches;

    document.body.classList.toggle("is-touch", isTouch);
    document.body.classList.toggle("is-portrait-locked", nowLocked);
    document.body.classList.toggle("is-fullscreen", isTouch && !nowLocked);

    if (nowLocked && !portraitLocked) pauseRun();
    portraitLocked = nowLocked;

    layout();
    // The world was generated for the old width - top it up for the new one.
    if (state !== State.MENU) ensureWorld();
    syncResumeGate();
  }

  /** Freeze a live run rather than letting the player fall while away. */
  function pauseRun() {
    releaseJump();
    if (state === State.PLAYING) awaitingResume = true;
  }

  function resumeRun() {
    if (!awaitingResume) return;
    awaitingResume = false;
    releaseJump();
    syncResumeGate();
  }

  /** The gate only shows once the player can actually act on it. */
  function syncResumeGate() {
    const show = awaitingResume && state === State.PLAYING && !portraitLocked;
    resumeGate.classList.toggle("hidden", !show);
  }

  function initResponsive() {
    const onChange = () => applyViewportMode();
    // Safari < 14 only has the deprecated listener form.
    for (const mq of [mqCoarse, mqPortrait]) {
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
    window.addEventListener("resize", onChange);
    window.addEventListener("orientationchange", onChange);

    // Leaving the tab / app mid-run should cost nothing.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        pauseRun();
        syncResumeGate();
      }
    });
    window.addEventListener("blur", () => {
      pauseRun();
      syncResumeGate();
    });

    resumeGate.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      resumeRun();
    });

    applyViewportMode();
  }

  // ── Input ─────────────────────────────────────────────────────
  let jumpPressed = false;
  let jumpHeld = false;
  let jumpReleased = false;

  /** A focused UI button owns SPACE / ENTER - don't also fire the game action. */
  function keyOwnedByUi(e) {
    return e.type === "keydown" && e.target && typeof e.target.closest === "function"
      ? Boolean(e.target.closest("button"))
      : false;
  }

  /**
   * Drop the held-jump flag without asking for a matching release event.
   * Touch has failure modes a keyboard doesn't: a system gesture, an
   * incoming call or a backgrounded tab can eat the touchend entirely, and
   * a stuck jumpHeld would kill jumping for the rest of the run.
   */
  function releaseJump() {
    jumpHeld = false;
    jumpReleased = false;
  }

  /** A front-end modal (manual, wardrobe or shop) owns the screen right now. */
  function inFrontEndModal() {
    return menuView === "instructions" || menuView === "skins" || menuView === "shop";
  }

  function onJumpDown(e) {
    if (e.type === "keydown" && e.code !== "Space" && e.key !== " ") return;
    if (inFrontEndModal() || keyOwnedByUi(e)) return;
    if (e.type === "keydown" && (e.code === "Space" || e.key === " ")) {
      e.preventDefault();
    }
    if (portraitLocked) return;
    // A paused run consumes the input that wakes it - no accidental jump.
    if (awaitingResume) {
      resumeRun();
      return;
    }
    // The finale is not skippable: SPACE does nothing until the banner has
    // finished its drop, so a held key from the winning jump can't eat it.
    if (state === State.VICTORY) {
      if (victoryTitleLanded) startGame();
      return;
    }
    if (state === State.MENU || state === State.DEAD) {
      startGame();
      return;
    }
    if (!jumpHeld) jumpPressed = true;
    jumpHeld = true;
  }

  function onJumpUp(e) {
    if (e && e.type === "keyup" && e.code !== "Space" && e.key !== " ") return;
    // Multi-touch: only the last finger leaving counts as a release,
    // otherwise a second finger lifting cuts a jump that's still held.
    if (e && e.touches && e.touches.length > 0) return;
    if (jumpHeld) jumpReleased = true;
    jumpHeld = false;
  }

  /**
   * Hidden test shortcut - keyboard only, deliberately absent from the manual.
   * 1-9 warp to that many thousand points; 0 lands at 9500 so the 10k ending
   * can be watched arriving under its own steam instead of being jumped past.
   */
  const WARP_KEYS = {
    Digit1: 1000,
    Digit2: 2000,
    Digit3: 3000,
    Digit4: 4000,
    Digit5: 5000,
    Digit6: 6000,
    Digit7: 7000,
    Digit8: 8000,
    Digit9: 9000,
    Digit0: 9500,
  };

  function onKeyDown(e) {
    if (e.code === "Escape") {
      if (menuView === "instructions") {
        e.preventDefault();
        closeManual();
      } else if (menuView === "skins") {
        e.preventDefault();
        closeSkins();
      } else if (menuView === "shop") {
        e.preventDefault();
        closeShop();
      }
      return;
    }
    // A front-end modal owns the screen - R, the warp keys and jump all wait
    if (inFrontEndModal()) return;
    if (portraitLocked) return;
    if (e.code === "KeyR" && !keyOwnedByUi(e)) {
      e.preventDefault();
      startGame();
      return;
    }
    // Secret desktop shortcut: 1–5 warp the run to 1k–5k pts (see warpToScore)
    if (WARP_KEYS[e.code] && !keyOwnedByUi(e)) {
      e.preventDefault();
      warpToScore(WARP_KEYS[e.code]);
      return;
    }
    onJumpDown(e);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onJumpUp);
  canvas.addEventListener("mousedown", onJumpDown);
  canvas.addEventListener("mouseup", onJumpUp);
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    onJumpDown(e);
  }, { passive: false });
  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    onJumpUp(e);
  }, { passive: false });
  canvas.addEventListener("touchcancel", (e) => {
    onJumpUp(e);
  }, { passive: true });
  // Belt and braces: whatever swallowed the touch, the flag comes back down.
  window.addEventListener("blur", releaseJump);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseJump();
  });

  // ── Level generation ──────────────────────────────────────────
  function resetWorld() {
    platforms = [];
    obstacles = [];
    particles = [];
    signs = [];
    enemies = [];
    bullets = [];
    fireworks = [];
    clearPowerups();
    steelHp = 0; // the shop re-arms it in applyShopLoadout()
    steelFlash = 0;
    distance = 0;
    runTime = 0;
    speed = BASE_SPEED;
    score = 0;
    nextSignValue = SIGN_INTERVAL;
    enemySpawnTimer = rand(ENEMY_SPAWN_MIN, ENEMY_SPAWN_MAX);
    themeIndex = 0;
    themeBlend = 1;
    lastThemeTier = 0;
    fireworksQueue = 0;
    victoryDrops = [];
    victoryT = 0;
    victoryTitleY = VICTORY_TITLE_START;
    victoryTitleLanded = false;

    // Starting solid runway so the player can get used to the feel
    let x = -40;
    platforms.push({ x, w: 520, y: GROUND_Y, h: H - GROUND_Y });
    x += 520;

    while (x < SPAWN_AHEAD) {
      x = spawnSegment(x);
    }

    // Pre-place a few early signs that fall on the starting stretch if any
    ensureSigns();
  }

  function spawnSegment(fromX) {
    const gap = rand(MIN_GAP, MAX_GAP) + Math.min(40, runTime * 2);
    const platW = rand(MIN_PLATFORM, MAX_PLATFORM) - Math.min(80, runTime * 3);
    // Keyed off world X, not score, so a warped run still generates real gaps.
    // The shop's No Gaps holds the opening runway's rule for the whole run.
    const gapFree = shopOn("nogaps") || fromX < GAP_FREE_UNTIL_SCORE * SCORE_TO_DIST;
    const start = gapFree ? fromX : fromX + Math.max(MIN_GAP, gap);
    const width = Math.max(140, platW);

    // In the gap-free stretch the slab is *merged* into the one behind it.
    // Two abutting platforms would each paint their 3px cliff face and leave
    // a dark seam every few hundred px across the whole opening runway.
    const prev = gapFree ? lastGroundPlatformEndingAt(start) : null;
    if (prev) {
      prev.w += width;
    } else {
      platforms.push({
        x: start,
        w: width,
        y: GROUND_Y,
        h: H - GROUND_Y,
      });
    }

    // Chance of a low ice spike / crate on the platform (not near edges)
    if (width > 200 && Math.random() < 0.55 + Math.min(0.25, runTime * 0.01)) {
      const type = Math.random() < 0.55 ? "spike" : "crate";
      const oh = type === "spike" ? 28 : 34;
      const ow = type === "spike" ? 30 : 34;
      const ox = start + rand(70, width - 70 - ow);
      obstacles.push({
        x: ox,
        y: GROUND_Y - oh,
        w: ow,
        h: oh,
        type,
      });
    }

    // Occasional floating ice block to jump onto / over
    if (width > 260 && Math.random() < 0.28) {
      const fw = rand(50, 90);
      const fx = start + rand(40, width - fw - 40);
      const fy = GROUND_Y - rand(70, 110);
      platforms.push({
        x: fx,
        w: fw,
        y: fy,
        h: 18,
      });
    }

    return start + width;
  }

  /**
   * Cut the spent tail off a ground slab that runs behind the player.
   * Gap-free stretches merge slab into slab (see spawnSegment), so with the
   * shop's No Gaps equipped a single platform would otherwise reach 100,000
   * units by the end of the run - and drawPlatforms walks its width in 48px
   * steps every frame. Trimming keeps that walk bounded to one screen.
   * Only the part already off the left edge is removed, so nothing the
   * player can see, stand on or fall into ever changes.
   */
  function trimGroundBehind() {
    const cut = distance - 300;
    for (const p of platforms) {
      if (p.isBridge || p.y < GROUND_Y - 1) continue;
      if (p.x >= cut || p.x + p.w <= cut) continue;
      p.w -= cut - p.x;
      p.x = cut;
    }
  }

  /** The ground slab whose right edge lands exactly on x, if there is one. */
  function lastGroundPlatformEndingAt(x) {
    for (const p of platforms) {
      if (p.y < GROUND_Y - 1 || p.isBridge) continue;
      if (Math.abs(p.x + p.w - x) < 0.5) return p;
    }
    return null;
  }

  function ensureWorld() {
    // Drop platforms / obstacles that scrolled off the left of the screen
    platforms = platforms.filter((p) => p.x + p.w > distance - 100);
    obstacles = obstacles.filter((o) => o.x + o.w > distance - 100);
    signs = signs.filter((s) => s.x > distance - 200);
    trimGroundBehind();

    let rightmost = platforms.reduce((m, p) => Math.max(m, p.x + p.w), 0);
    while (rightmost < distance + SPAWN_AHEAD) {
      rightmost = spawnSegment(rightmost);
    }

    ensureSigns();
  }

  /** Place milestone signs at world X for each 100-pt mark. */
  function ensureSigns() {
    // Stay within generated platforms so gap-vs-ice is accurate
    const maxWorldX = distance + SPAWN_AHEAD;
    while (nextSignValue * SCORE_TO_DIST < maxWorldX) {
      const targetX = nextSignValue * SCORE_TO_DIST;
      const placed = placeSign(targetX);
      signs.push({
        x: placed.x,
        value: nextSignValue,
        floating: placed.floating,
        bob: Math.random() * Math.PI * 2,
      });
      nextSignValue += SIGN_INTERVAL;
    }
  }

  /**
   * Plant the sign on ice if a ground platform covers targetX;
   * otherwise float it in a bubble over the gap at the exact milestone X.
   */
  function placeSign(targetX) {
    for (const p of platforms) {
      if (p.y < GROUND_Y - 1) continue;
      // Interior of platform (keep clear of cliff edges)
      const left = p.x + 24;
      const right = p.x + p.w - 24;
      if (targetX >= left && targetX <= right) {
        return { x: targetX, floating: false };
      }
    }
    // Gap (or edge) - bubble float at the milestone world X
    return { x: targetX, floating: true };
  }

  // ── Enemies (spawn / update / stomp) ──────────────────────────

  /**
   * Resolve a type id, a live enemy (.type) or a registry entry (.id) to its
   * ENEMY_TYPES row. All three are accepted on purpose: the fallback below is
   * silent, so handing this the wrong shape surfaces as a raider-shaped bug
   * (wrong size, wrong art) rather than an error.
   */
  function getEnemyDef(typeOrEnemy) {
    if (!typeOrEnemy) return ENEMY_TYPES[EnemyKind.RAIDER];
    const id =
      typeof typeOrEnemy === "string"
        ? typeOrEnemy
        : typeOrEnemy.type || typeOrEnemy.id;
    return ENEMY_TYPES[id] || ENEMY_TYPES[EnemyKind.RAIDER];
  }

  /** Body size in px for a type id or live enemy (brutes are 2×). */
  function enemySizeOf(typeOrEnemy) {
    return getEnemyDef(typeOrEnemy).size || ENEMY_SIZE;
  }

  /**
   * How far the head spikes are out, 0..1. Drawing and the stomp rule both
   * read this, so the sprite can never disagree with the hitbox rule.
   */
  function enemySpikeExtend(e) {
    const def = getEnemyDef(e);
    if (def.spikes === "always") return 1;
    if (def.spikes !== "toggle") return 0;
    const t = (e.spikeT || 0) % SPIKE_CYCLE;
    if (t < SPIKE_RAMP) return t / SPIKE_RAMP; // popping out
    if (t < 1) return 1; // fully out
    if (t < 1 + SPIKE_RAMP) return 1 - (t - 1) / SPIKE_RAMP; // retracting
    return 0; // tucked in - safe to stomp
  }

  /** True while the spikes block a stomp (half-extended counts as out). */
  function enemySpikesOut(e) {
    return enemySpikeExtend(e) >= 0.5;
  }

  /** Earliest score at which any enemy type unlocks. */
  function earliestEnemyUnlock() {
    let min = Infinity;
    for (const t of Object.values(ENEMY_TYPES)) {
      if (t.unlockScore < min) min = t.unlockScore;
    }
    return min;
  }

  /** Weighted pick among enemy types unlocked at the current score. */
  /**
   * Spawn weight for this run. Computed rather than stored: the shop's
   * Double Droppers must not leave a doubled weight behind in ENEMY_TYPES
   * once it is unequipped.
   */
  function enemySpawnWeight(t) {
    if (t.id === EnemyKind.DROPPER && shopOn("dropper2")) return t.spawnWeight * 2;
    return t.spawnWeight;
  }

  function pickEnemyType() {
    const unlocked = Object.values(ENEMY_TYPES).filter((t) => score >= t.unlockScore);
    if (!unlocked.length) return null;
    let total = 0;
    for (const t of unlocked) total += enemySpawnWeight(t);
    let r = Math.random() * total;
    for (const t of unlocked) {
      r -= enemySpawnWeight(t);
      if (r <= 0) return t.id;
    }
    return unlocked[unlocked.length - 1].id;
  }

  function spawnEnemy() {
    const typeId = pickEnemyType();
    if (!typeId) return;
    const def = getEnemyDef(typeId);

    const size = enemySizeOf(typeId);

    // Commandos drop in over the visible track instead of walking on from the
    // right, so they get a screen X well ahead of the player and a sky start.
    // Far enough right that there is still reaction time after the chute is
    // cut - it closes at the full scroll speed the moment it is on its feet.
    const screenX = def.parachute ? rand(W * 0.62, W - 90) : 0;
    // Spawn ahead of the player (off-screen right), approach from opposite direction
    let worldX = def.parachute ? distance + screenX : distance + W + rand(40, 160);

    // Flyers cruise at altitude and never touch the ice; the rest prefer a slab
    let y;
    if (def.parachute) {
      y = CHUTE_SPAWN_Y;
    } else if (def.flying) {
      const lo = typeId === EnemyKind.ULTIMATE ? ULTIMATE_HOVER_MIN : FLY_HOVER_MIN;
      const hi = typeId === EnemyKind.ULTIMATE ? ULTIMATE_HOVER_MAX : FLY_HOVER_MAX;
      y = GROUND_Y - size - rand(lo, hi);
    } else {
      let slab = groundSlabUnder(worldX, size);
      // A lazer raider needs to outlive its own wind-up. Dropped over a gap it
      // is off the bottom of the screen in about a third of a second - long
      // before the 0.9s charge lands - so it gets walked back onto solid ice,
      // near the trailing edge of a slab it can spend the whole charge on.
      if (!slab && def.beam) {
        const placed = findBeamFooting(size);
        if (placed) {
          worldX = placed.x;
          slab = placed.slab;
        }
      }
      y = slab ? slab.y - size : GROUND_Y - size;
    }

    enemies.push({
      type: typeId,
      x: worldX,
      y,
      w: size,
      h: size,
      vy: 0,
      shootCd: def.canShoot ? rand(0.4, SHOOT_COOLDOWN) : 0,
      bob: Math.random() * Math.PI * 2,
      // Flyers hold their cruise line; the sine rides on top of it
      baseY: y,
      // Desync spike cycles so a cluster doesn't pulse in lockstep
      spikeT: def.spikes === "toggle" ? Math.random() * SPIKE_CYCLE : 0,
      // Lazer: seconds until the wind-up starts, then charge → 100ms beam
      laserCd: def.beam ? rand(LASER_FIRST_SHOT_MIN, LASER_FIRST_SHOT_MAX) : 0,
      chargeT: 0,
      beamT: 0,
      // Commando: holds this screen X until the chute is cut on landing
      chuting: !!def.parachute,
      screenX,
      // Ice raider: how far the skid streak trails behind it, 0..1
      skid: 0,
    });
  }

  /** The ground slab an enemy of `size` would stand on at worldX, or null. */
  function groundSlabUnder(worldX, size) {
    for (const p of platforms) {
      if (p.y < GROUND_Y - 1) continue;
      if (worldX >= p.x + 10 && worldX <= p.x + p.w - size - 10) return p;
    }
    return null;
  }

  /**
   * Pick a spot in the spawn band that a lazer raider can actually finish a
   * charge on: the right-hand end of a slab inside the band, so the whole
   * wind-up is spent walking across ice rather than off the edge of it.
   */
  function findBeamFooting(size) {
    const from = distance + W + 20;
    const to = distance + W + 520;
    let best = null;
    for (const p of platforms) {
      if (p.y < GROUND_Y - 1 || p.isBridge) continue;
      const right = p.x + p.w - size - 12;
      const left = p.x + 10;
      if (right < from || left > to) continue;
      if (right - left < size) continue; // too narrow to stand on
      const x = Math.max(left, Math.min(right, to));
      if (x < from) continue;
      // Pick the slab that leaves the most ice to its left: the raider spends
      // the whole charge walking that way, and running out of it means no beam.
      const room = x - left;
      if (!best || room > best.room) best = { x, slab: p, room };
    }
    return best;
  }

  function enemyCanShoot(e) {
    const def = getEnemyDef(e);
    return !!(def.canShoot && score >= def.unlockScore);
  }

  /** Squash enemy under the player's feet. Handles drops + FX. */
  function stompEnemy(index, screenX) {
    const e = enemies[index];
    if (!e) return;
    const def = getEnemyDef(e);
    const cx = screenX + e.w / 2;
    const cy = e.y + e.h * 0.55;

    const color = def.fxColor;

    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(60, 220);
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 40,
        life: rand(0.25, 0.55),
        max: 0.55,
        r: rand(2, 5),
        color,
      });
    }
    spawnDust(cx, e.y + e.h);
    shake = Math.max(shake, 5);

    // Grant powerup if this type drops one (see ENEMY_TYPES.dropPowerup)
    if (def.dropPowerup) {
      const pid =
        def.dropPowerup === "random" ? pickRandomDropPowerup() : def.dropPowerup;
      grantPowerup(pid);
    }

    enemies.splice(index, 1);
  }

  /**
   * Shatter an ice hazard - a crate stomped from above, or anything a steel
   * shell bumps into. Mirrors stompEnemy's FX.
   */
  function shatterObstacle(index, screenX) {
    const o = obstacles[index];
    if (!o) return;
    const cx = screenX + o.w / 2;
    const cy = o.y + o.h * 0.55;
    const shard = o.type === "spike" ? "rgba(154, 208, 239," : "rgba(184, 216, 240,";

    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(60, 220);
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 40,
        life: rand(0.25, 0.55),
        max: 0.55,
        r: rand(2, 5),
        color: Math.random() < 0.5 ? shard : "rgba(74, 122, 152,",
      });
    }
    spawnDust(cx, o.y + o.h);
    shake = Math.max(shake, 5);

    obstacles.splice(index, 1);
  }

  /** Equal chance among all registered droppable powerups. */
  function pickRandomDropPowerup() {
    const pool = POWERUP_DROP_IDS.filter((id) => POWERUP_DEFS[id]);
    if (!pool.length) return null;
    return pool[(Math.random() * pool.length) | 0];
  }

  /**
   * Bounce after a stomp. Timed Space (buffer / grace) = super jump:
   * hold to reach ~2× normal jump height; release early to cut it short.
   */
  function applyStompBounce(enemyTopY) {
    player.y = enemyTopY - player.h;
    player.onGround = false;
    player.coyote = 0;
    player.rotation = 0;

    const timedJump = player.jumpBuffer > 0;
    if (timedJump) {
      applyStompBoost(enemyTopY);
    } else {
      player.vy = STOMP_BOUNCE;
      player.squish = 0.68;
      player.stompJumpGrace = STOMP_JUMP_GRACE;
    }
  }

  function applyStompBoost(enemyTopY) {
    player.y = enemyTopY != null ? enemyTopY - player.h : player.y;
    player.vy = STOMP_BOOST_VELOCITY;
    player.jumpBuffer = 0;
    player.stompJumpGrace = 0;
    player.onGround = false;
    player.coyote = 0;
    player.squish = 0.55;
    player.rotation = 0;
    skinOnJump();
    shake = Math.max(shake, 6);

    // Bright lift FX so a perfect stomp-jump reads clearly
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h;
    for (let i = 0; i < 10; i++) {
      particles.push({
        x: cx + rand(-10, 10),
        y: cy,
        vx: rand(-50, 50),
        vy: rand(-180, -60),
        life: rand(0.25, 0.5),
        max: 0.5,
        r: rand(2, 4),
        color: "rgba(120, 255, 200,",
      });
    }
  }

  function updateEnemies(dt) {
    if (score < earliestEnemyUnlock()) return;

    const unlock = earliestEnemyUnlock();
    const spawnBoost = Math.min(0.9, (score - unlock) / 3000);
    enemySpawnTimer -= dt;
    if (enemySpawnTimer <= 0) {
      spawnEnemy();
      enemySpawnTimer = rand(ENEMY_SPAWN_MIN, ENEMY_SPAWN_MAX) * (1 - spawnBoost * 0.45);
    }

    const approach = ENEMY_APPROACH + Math.min(80, score * 0.04);

    for (const e of enemies) {
      const def = getEnemyDef(e);

      // Move opposite to player travel (leftward in world space). A commando
      // under its chute is the one exception: it holds a fixed *screen* X, so
      // its world X has to keep pace with the scroll instead of drifting back.
      if (e.chuting) {
        e.x = distance + e.screenX;
      } else {
        e.x -= approach * (def.speedMul || 1) * dt;
      }
      e.bob += dt * 6;
      if (def.spikes === "toggle") e.spikeT += dt;
      if (def.speedMul > 1) e.skid = Math.min(1, e.skid + dt * 4);
      if (def.beam) updateLaserRaider(e, dt);

      if (def.flying) {
        // No gravity and no platform test - flyers cruise straight over gaps.
        e.y = e.baseY + Math.sin(e.bob * 0.5) * FLY_BOB;
      } else if (e.chuting) {
        // Slow, steady float down until the ice (or the abyss) arrives.
        e.y += CHUTE_FALL_SPEED * dt;
        for (const p of platforms) {
          const feet = e.y + e.h;
          const overlappingX = e.x + e.w > p.x + 2 && e.x < p.x + p.w - 2;
          if (overlappingX && feet >= p.y && feet <= p.y + 14) {
            e.y = p.y - e.h;
            e.vy = 0;
            e.chuting = false; // chute cut - from here it's a normal raider
            spawnDust(e.x - distance + e.w / 2, p.y);
            break;
          }
        }
      } else {
        // Simple gravity so they fall into gaps
        e.vy += FALL_GRAVITY * 0.85 * dt;
        e.y += e.vy * dt;

        let onGround = false;
        for (const p of platforms) {
          const wasAbove = e.y + e.h - e.vy * dt <= p.y + 2;
          const feet = e.y + e.h;
          const overlappingX = e.x + e.w > p.x + 2 && e.x < p.x + p.w - 2;
          if (
            overlappingX &&
            wasAbove &&
            feet >= p.y &&
            feet <= p.y + Math.max(12, Math.abs(e.vy) * dt + 8) &&
            e.vy >= 0
          ) {
            e.y = p.y - e.h;
            e.vy = 0;
            onGround = true;
          }
        }

        // Hop occasionally so they're not pure walls
        if (onGround && Math.random() < 0.004) {
          e.vy = JUMP_VELOCITY * 0.55;
        }
      }

      // Type-specific behavior (shooting gunners, etc.)
      if (enemyCanShoot(e)) {
        e.shootCd -= dt;
        const sx = e.x - distance;
        if (e.shootCd <= 0 && sx > player.x - 20 && sx < W + 40) {
          shootAtPlayer(e);
          e.shootCd = SHOOT_COOLDOWN + rand(-0.25, 0.4);
        }
      }
    }

    enemies = enemies.filter((e) => e.x - distance > -120 && e.y < H + 80);
  }

  /**
   * Lazer raider cycle: reload → charge (telegraphed) → 100ms beam → reload.
   * The wind-up only starts once the raider is actually on screen, so a beam
   * can never arrive from somewhere the player was never given a chance to see.
   */
  function updateLaserRaider(e, dt) {
    if (e.beamT > 0) {
      e.beamT = Math.max(0, e.beamT - dt);
      if (e.beamT === 0) e.laserCd = rand(LASER_RELOAD_MIN, LASER_RELOAD_MAX);
      return;
    }
    if (e.chargeT > 0) {
      e.chargeT = Math.max(0, e.chargeT - dt);
      if (e.chargeT === 0) {
        e.beamT = LASER_BEAM;
        shake = Math.max(shake, 5);
        const sx = e.x - distance;
        const cy = e.y + e.h * 0.5;
        for (let i = 0; i < 8; i++) {
          particles.push({
            x: sx,
            y: cy,
            vx: rand(-260, -60),
            vy: rand(-50, 50),
            life: rand(0.15, 0.35),
            max: 0.35,
            r: rand(2, 4),
            color: "rgba(255, 120, 230,",
          });
        }
      }
      return;
    }
    const sx = e.x - distance;
    if (sx < player.x - 40 || sx > W + 60) return; // off screen - hold fire
    e.laserCd -= dt;
    if (e.laserCd <= 0) e.chargeT = LASER_CHARGE;
  }

  /**
   * The live beam in world space, or null. Drawing and the kill check both
   * read this, so the streak on screen is exactly the rectangle that hurts.
   */
  function laserBeamRect(e) {
    if (!(e.beamT > 0)) return null;
    return {
      x: e.x - LASER_RANGE,
      y: e.y + e.h * 0.5 - LASER_THICKNESS / 2,
      w: LASER_RANGE,
      h: LASER_THICKNESS,
    };
  }

  // ── Powerups ──────────────────────────────────────────────────

  function clearPowerups() {
    activePowerups.clear();
    hitInvuln = 0;
  }

  function powerupSparkleColor(id) {
    if (id === "shield") return "rgba(120, 220, 255,";
    if (id === "wings") return "rgba(200, 180, 255,";
    if (id === "gun") return "rgba(255, 160, 80,";
    if (id === "bridge") return "rgba(220, 180, 100,";
    return "rgba(255, 220, 100,";
  }

  /**
   * Activate or refresh a powerup by id (see POWERUP_DEFS).
   * opts.permanent - never ticks down (shop mods; remaining stays Infinity).
   * opts.quiet     - skip the pickup sparkles, for grants the player didn't
   *                  earn this instant (a Fly wing topped up on landing).
   */
  function grantPowerup(id, opts) {
    const def = POWERUP_DEFS[id];
    if (!def) return;
    const permanent = Boolean(opts && opts.permanent);
    const quiet = Boolean(opts && opts.quiet);

    if (def.exclusive) {
      for (const [otherId, other] of activePowerups) {
        if (other.def.exclusive && otherId !== id) {
          expirePowerup(otherId, false);
        }
      }
    }

    const existing = activePowerups.get(id);
    if (existing) {
      // Refresh timer on re-collect - but a permanent grant is never
      // downgraded by one that happens to arrive out of a dropper.
      if (permanent) existing.permanent = true;
      existing.remaining = existing.permanent ? Infinity : def.duration;
      if (id === "gun") existing.fireCd = 0;
    } else {
      activePowerups.set(id, {
        id,
        remaining: permanent ? Infinity : def.duration,
        permanent,
        def,
        fireCd: id === "gun" ? 0.05 : 0,
      });
    }

    if (typeof def.onGrant === "function") def.onGrant();
    if (quiet) return;

    // Pickup sparkles
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const color = powerupSparkleColor(id);
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(40, 160);
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: rand(0.3, 0.6),
        max: 0.6,
        r: rand(2, 4),
        color,
      });
    }
  }

  function expirePowerup(id, runHook) {
    const state = activePowerups.get(id);
    if (!state) return;
    activePowerups.delete(id);
    if (runHook !== false && typeof state.def.onExpire === "function") {
      state.def.onExpire();
    }
  }

  function hasPowerup(id) {
    return activePowerups.has(id);
  }

  function updatePowerups(dt) {
    for (const [id, state] of [...activePowerups]) {
      if (id === "gun") {
        updateGunPowerup(state, dt);
      }
      if (typeof state.def.onUpdate === "function") {
        state.def.onUpdate(state, dt);
      }
      if (state.def.duration > 0) {
        state.remaining -= dt;
        if (state.remaining <= 0) {
          expirePowerup(id, true);
        }
      }
    }
  }

  /**
   * Gun: auto-fire at the nearest on-screen enemy ahead of the player.
   * Friendly bullets are marked so they don't hurt the player.
   */
  function updateGunPowerup(state, dt) {
    state.fireCd = (state.fireCd || 0) - dt;
    if (state.fireCd > 0) return;

    let target = null;
    let best = Infinity;
    for (const e of enemies) {
      const sx = e.x - distance;
      // Must be in view and roughly "coming" (at or ahead of the player)
      if (sx + e.w < player.x - 10) continue;
      if (sx > W + 30) continue;
      const dy = Math.abs(e.y + e.h / 2 - (player.y + player.h / 2));
      if (dy > GUN_SIGHT_Y) continue;
      const dist = sx - player.x;
      if (dist < best) {
        best = dist;
        target = e;
      }
    }
    if (!target) return;

    state.fireCd = GUN_FIRE_INTERVAL;

    const originX = distance + player.x + player.w;
    const originY = player.y + player.h * 0.42;
    const aimX = target.x + target.w * 0.35;
    const aimY = target.y + target.h * 0.4;
    // Slight lead for enemy approach + world scroll
    const leadX = aimX - ENEMY_APPROACH * 0.12;
    const dx = leadX - originX;
    const dy = aimY - originY;
    const len = Math.hypot(dx, dy) || 1;

    bullets.push({
      x: originX,
      y: originY,
      vx: (dx / len) * PLAYER_BULLET_SPEED,
      vy: (dy / len) * PLAYER_BULLET_SPEED,
      r: 4.5,
      friendly: true,
    });

    // Muzzle flash (screen space)
    const mx = player.x + player.w;
    for (let i = 0; i < 4; i++) {
      particles.push({
        x: mx + rand(0, 6),
        y: originY + rand(-3, 3),
        vx: rand(40, 120),
        vy: rand(-40, 40),
        life: rand(0.12, 0.28),
        max: 0.28,
        r: rand(1.5, 3),
        color: "rgba(255, 200, 100,",
      });
    }
  }

  /**
   * Shop mods that hand out a powerup and then have to keep it there.
   * Run every frame rather than granted once at the start: a dropper roll can
   * refresh the gun, tryWingsJump() spends the wings, and warpToScore() wipes
   * both. Topping up here means none of those paths need to know about the shop.
   */
  function enforceShopPowerups() {
    if (shopOn("forevergun")) {
      const gun = activePowerups.get("gun");
      if (!gun) grantPowerup("gun", { permanent: true, quiet: true });
      else if (!gun.permanent) grantPowerup("gun", { permanent: true, quiet: true });
    }
    // Fly is a double jump, not flight: the wing comes back on landing, so
    // there is still exactly one extra jump per trip through the air.
    if (shopOn("fly") && player.onGround && !hasPowerup("wings")) {
      grantPowerup("wings", { permanent: true, quiet: true });
    }
  }

  /** Wings: air-only second jump; consumes the powerup. */
  function tryWingsJump() {
    if (!hasPowerup("wings")) return false;
    if (player.onGround || player.coyote > 0) return false;
    if (player.jumpBuffer <= 0) return false;

    player.vy = JUMP_VELOCITY;
    player.jumpBuffer = 0;
    player.squish = 0.62;
    player.rotation = 0;
    player.stompJumpGrace = 0;
    skinOnJump();
    spawnWingsPop();
    expirePowerup("wings", true);
    shake = Math.max(shake, 4);
    return true;
  }

  function spawnWingsPop() {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h * 0.35;
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      particles.push({
        x: cx + side * rand(8, 18),
        y: cy + rand(-6, 6),
        vx: side * rand(40, 140),
        vy: rand(-120, -20),
        life: rand(0.3, 0.6),
        max: 0.6,
        r: rand(2, 4.5),
        color: "rgba(210, 190, 255,",
      });
    }
  }

  /**
   * Bridge: when the player is falling into a ground-level gap, fill that gap
   * with a solid platform and consume the powerup. Bridge stays in the world.
   */
  function tryDeployBridge() {
    if (!hasPowerup("bridge")) return false;
    if (player.onGround) return false;

    const feet = player.y + player.h;
    // Only near the main ice line (not mid-air jumps or already deep in the pit)
    if (feet < GROUND_Y - 6) return false;
    if (feet > GROUND_Y + 55) return false;
    if (player.vy < -30) return false; // still rising

    const worldMid = distance + player.x + player.w * 0.5;

    // If any platform already supports us, don't waste the bridge
    for (const p of platforms) {
      const left = p.x;
      const right = p.x + p.w;
      if (worldMid > left + 2 && worldMid < right - 2) {
        if (Math.abs(p.y - GROUND_Y) < 2) return false;
        // Floating platform we're about to land on
        if (
          player.vy >= 0 &&
          feet >= p.y - 4 &&
          feet <= p.y + 24 &&
          player.y < p.y
        ) {
          return false;
        }
      }
    }

    const gap = findGapContaining(worldMid);
    if (!gap || gap.w < 10) return false;

    platforms.push({
      x: gap.x,
      w: gap.w,
      y: GROUND_Y,
      h: H - GROUND_Y,
      isBridge: true,
    });

    player.y = GROUND_Y - player.h;
    player.vy = 0;
    player.onGround = true;
    player.coyote = COYOTE_TIME;
    player.rotation = 0;
    player.squish = 1.12;

    expirePowerup("bridge", true);
    spawnBridgeFx(gap);
    shake = Math.max(shake, 5);
    return true;
  }

  /** Locate the open ground gap that contains worldX (between two main ice slabs). */
  function findGapContaining(worldX) {
    const grounds = platforms
      .filter((p) => p.y >= GROUND_Y - 1)
      .slice()
      .sort((a, b) => a.x - b.x);

    for (let i = 0; i < grounds.length; i++) {
      const cur = grounds[i];
      const next = grounds[i + 1];
      if (!next) break;
      const leftEnd = cur.x + cur.w;
      const rightStart = next.x;
      const width = rightStart - leftEnd;
      if (width < 10) continue;
      if (worldX >= leftEnd - 12 && worldX <= rightStart + 12) {
        return { x: leftEnd, w: width };
      }
    }
    return null;
  }

  function spawnBridgeFx(gap) {
    const startSx = gap.x - distance;
    for (let i = 0; i < 16; i++) {
      particles.push({
        x: startSx + Math.random() * gap.w,
        y: GROUND_Y + rand(-2, 6),
        vx: rand(-40, 40),
        vy: rand(-100, -20),
        life: rand(0.3, 0.55),
        max: 0.55,
        r: rand(2, 5),
        color: "rgba(210, 170, 90,",
      });
    }
  }

  /** Friendly (player gun) bullets destroy enemies on contact - no stomp rewards. */
  function resolveFriendlyBullets() {
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
      const b = bullets[bi];
      if (!b.friendly) continue;

      let hit = false;
      for (let ei = enemies.length - 1; ei >= 0; ei--) {
        const e = enemies[ei];
        if (
          !rectsOverlap(
            b.x - b.r,
            b.y - b.r,
            b.r * 2,
            b.r * 2,
            e.x,
            e.y,
            e.w,
            e.h
          )
        ) {
          continue;
        }

        const sx = e.x - distance;
        const cx = sx + e.w / 2;
        const cy = e.y + e.h * 0.5;
        const color = getEnemyDef(e).fxColor;
        for (let i = 0; i < 12; i++) {
          const ang = Math.random() * Math.PI * 2;
          const sp = rand(50, 200);
          particles.push({
            x: cx,
            y: cy,
            vx: Math.cos(ang) * sp,
            vy: Math.sin(ang) * sp - 30,
            life: rand(0.2, 0.5),
            max: 0.5,
            r: rand(2, 4),
            color,
          });
        }
        enemies.splice(ei, 1);
        hit = true;
        break;
      }
      if (hit) bullets.splice(bi, 1);
    }
  }

  /**
   * If any active powerup absorbs a lethal contact, consume it and return true.
   * Call this before die() for obstacles / enemies / bullets.
   */
  function tryAbsorbHit() {
    for (const [id, state] of activePowerups) {
      if (state.def.absorbHit) {
        // Pop FX for shield
        if (id === "shield") {
          spawnShieldPop();
        }
        expirePowerup(id, true);
        hitInvuln = 0.5; // grace so the same spike/enemy doesn't re-hit instantly
        shake = Math.max(shake, 7);
        return true;
      }
    }
    return false;
  }

  /**
   * Route for all lethal contact hazards.
   * Returns true if the player died, false if absorbed / invulnerable.
   * Falling into the abyss should still call die() directly (not a "hit").
   *
   * `destroy` is the steel shell's half of the bargain: whatever was bumped
   * into is wrecked by the impact. Callers that already remove the enemy /
   * bullet on an absorbed hit can leave it out.
   */
  function playerTakeHit(reason, destroy) {
    if (hitInvuln > 0) return false;
    if (tryAbsorbHit()) return false;
    if (steelHp > 0) return steelTakeHit(destroy);
    die(reason);
    return true;
  }

  /**
   * Made of Steel: the impact cracks the shell instead of the player, and
   * takes whatever caused it with it. Returns true only on the hit that
   * shatters the last plate.
   */
  function steelTakeHit(destroy) {
    steelHp -= 1;
    steelFlash = 0.35;
    hitInvuln = 0.45; // one overlap must not chew through several plates
    shake = Math.max(shake, 6);
    spawnSteelSparks(steelHp <= 0);
    if (typeof destroy === "function") destroy();

    if (steelHp <= 0) {
      die("Your steel shell finally shattered. Ten hits was all it had.");
      return true;
    }
    return false;
  }

  function spawnSteelSparks(shattered) {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const n = shattered ? 22 : 12;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(70, shattered ? 300 : 190);
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 30,
        life: rand(0.2, 0.5),
        max: 0.5,
        r: rand(1.5, 4),
        color: Math.random() < 0.5 ? "rgba(210, 226, 240," : "rgba(255, 214, 140,",
      });
    }
  }

  function spawnShieldPop() {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    for (let i = 0; i < 16; i++) {
      const ang = (Math.PI * 2 * i) / 16;
      const sp = rand(80, 200);
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: rand(0.25, 0.5),
        max: 0.5,
        r: rand(2, 4),
        color: "rgba(160, 230, 255,",
      });
    }
  }

  /** Draw overlays for all active powerups (called after player body). */
  function drawPowerupOverlays() {
    for (const state of activePowerups.values()) {
      if (state.id === "shield") drawShieldBubble(state);
      else if (state.id === "wings") drawWingsOverlay(state);
      else if (state.id === "gun") drawGunOverlay(state);
      else if (state.id === "bridge") drawBridgeOverlay(state);
    }
  }

  /** Shared blink gate for timed powerups (returns false = skip draw this frame). */
  function powerupBlinkVisible(state) {
    if (state.def.duration <= 0 || state.def.warnAt <= 0) return true;
    if (state.remaining > state.def.warnAt) return true;
    return Math.sin(performance.now() / 80) > 0;
  }

  function drawWingsOverlay(_state) {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h * 0.4;
    const flap = Math.sin(performance.now() / 140) * 0.18;

    ctx.save();
    ctx.translate(cx, cy);

    // Left wing
    ctx.save();
    ctx.rotate(-0.55 + flap);
    drawWingShape(-1);
    ctx.restore();

    // Right wing
    ctx.save();
    ctx.rotate(0.55 - flap);
    drawWingShape(1);
    ctx.restore();

    ctx.restore();
  }

  function drawWingShape(dir) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(dir * 22, -16, dir * 28, 2);
    ctx.quadraticCurveTo(dir * 18, 10, 0, 6);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -12, dir * 28, 8);
    g.addColorStop(0, "rgba(255, 255, 255, 0.9)");
    g.addColorStop(0.5, "rgba(200, 185, 255, 0.75)");
    g.addColorStop(1, "rgba(150, 130, 230, 0.35)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 100, 200, 0.55)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function drawGunOverlay(state) {
    if (!powerupBlinkVisible(state)) return;

    const gx = player.x + player.w - 2;
    const gy = player.y + player.h * 0.42;

    ctx.save();
    let alpha = 1;
    if (state.remaining <= state.def.warnAt) {
      alpha = 0.55 + 0.35 * Math.abs(Math.sin(performance.now() / 80));
    }
    ctx.globalAlpha = alpha;

    // Blaster body (points forward / right)
    ctx.fillStyle = "#3a3a48";
    ctx.fillRect(gx, gy - 3, 14, 7);
    ctx.fillStyle = "#6a6a78";
    ctx.fillRect(gx + 12, gy - 1, 7, 3);
    ctx.fillStyle = "rgba(255, 180, 70, 0.9)";
    ctx.beginPath();
    ctx.arc(gx + 20, gy + 0.5, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Grip
    ctx.fillStyle = "#2a2a34";
    ctx.fillRect(gx + 2, gy + 3, 5, 6);

    ctx.restore();
  }

  function drawBridgeOverlay(_state) {
    // Small plank icon hovering above the player while held
    const cx = player.x + player.w / 2;
    const by = player.y - 14;
    const bob = Math.sin(performance.now() / 320) * 2;

    ctx.save();
    ctx.translate(cx, by + bob);

    // Plank
    roundRect(-12, -3, 24, 7, 2);
    const g = ctx.createLinearGradient(-12, -3, 12, 4);
    g.addColorStop(0, "#e8c878");
    g.addColorStop(0.5, "#c89840");
    g.addColorStop(1, "#8a6020");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(60, 40, 10, 0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Grain lines
    ctx.strokeStyle = "rgba(80, 50, 15, 0.3)";
    ctx.beginPath();
    ctx.moveTo(-8, -1);
    ctx.lineTo(8, -1);
    ctx.moveTo(-6, 2);
    ctx.lineTo(6, 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawShieldBubble(state) {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const r = Math.max(player.w, player.h) * 0.72;

    // Blink when in warning window (last warnAt seconds)
    let alpha = 0.85;
    if (state.remaining <= state.def.warnAt) {
      if (!powerupBlinkVisible(state)) return;
      alpha = 0.55 + 0.35 * Math.abs(Math.sin(performance.now() / 80));
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    const g = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.25, 2, cx, cy, r);
    g.addColorStop(0, "rgba(200, 245, 255, 0.35)");
    g.addColorStop(0.55, "rgba(100, 200, 255, 0.12)");
    g.addColorStop(1, "rgba(60, 160, 220, 0.05)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(160, 230, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Tiny highlight arc
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, -Math.PI * 0.9, -Math.PI * 0.5);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Made of Steel: riveted plating over whatever skin is equipped, a fresh
   * crack for every plate lost, and a pip row so the player can count what's
   * left without doing arithmetic on the cracks.
   *
   * Fixed crack geometry, revealed in order - random splinters would redraw
   * themselves every frame and read as static rather than as damage.
   */
  const STEEL_CRACKS = [
    [[-19, -5], [-9, -1], [-4, -11]],
    [[19, 3], [9, 0], [4, 10]],
    [[-3, -19], [-1, -8], [7, -4]],
    [[2, 19], [0, 7], [-8, 3]],
    [[-19, 9], [-10, 7], [-6, 15]],
    [[19, -8], [10, -6], [5, -14]],
    [[-14, -16], [-6, -8], [2, -12]],
    [[15, 15], [6, 8], [-2, 13]],
    [[-19, 0], [0, 2], [19, -2]],
  ];

  function drawSteelShell() {
    const dmg = Math.min(STEEL_CRACKS.length, STEEL_HP - steelHp);
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const w = player.w;
    const h = player.h;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(player.rotation);
    ctx.scale(player.squish, 2 - player.squish);

    // Plating: a brushed rim over the body, never a solid fill - the skin
    // underneath still has to be recognisable through it.
    const plate = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    plate.addColorStop(0, "rgba(238, 246, 255, 0.9)");
    plate.addColorStop(0.45, "rgba(150, 168, 188, 0.75)");
    plate.addColorStop(1, "rgba(70, 86, 104, 0.85)");
    roundRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4, 7);
    ctx.strokeStyle = plate;
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // Faint metal wash so the square reads as clad, not merely outlined
    roundRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2, 6);
    ctx.fillStyle = "rgba(176, 196, 216, 0.18)";
    ctx.fill();

    // Corner rivets
    ctx.fillStyle = "rgba(228, 240, 252, 0.85)";
    for (const [rx, ry] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.arc(rx * (w / 2 - 3), ry * (h / 2 - 3), 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cracks earned so far
    ctx.strokeStyle = "rgba(18, 30, 44, 0.75)";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    for (let i = 0; i < dmg; i++) {
      const path = STEEL_CRACKS[i];
      ctx.beginPath();
      ctx.moveTo(path[0][0], path[0][1]);
      for (let j = 1; j < path.length; j++) ctx.lineTo(path[j][0], path[j][1]);
      ctx.stroke();
    }

    // The impact itself - a white bloom that fades over ~a third of a second
    if (steelFlash > 0) {
      ctx.globalAlpha = Math.min(1, steelFlash / 0.35) * 0.65;
      roundRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4, 7);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    drawSteelPips();
  }

  /** One pip per plate left, floating over the square. Screen space: the
   *  count has to stay readable while the square is spinning through the air. */
  function drawSteelPips() {
    const pipW = 4;
    const gap = 2;
    const total = STEEL_HP * pipW + (STEEL_HP - 1) * gap;
    const x0 = player.x + player.w / 2 - total / 2;
    const y = player.y - 13;

    for (let i = 0; i < STEEL_HP; i++) {
      const x = x0 + i * (pipW + gap);
      const alive = i < steelHp;
      ctx.fillStyle = alive
        ? steelHp <= 3
          ? "rgba(255, 150, 120, 0.95)"
          : "rgba(206, 226, 246, 0.95)"
        : "rgba(120, 140, 160, 0.28)";
      ctx.fillRect(x, y, pipW, 5);
    }
  }

  function shootAtPlayer(e) {
    // World-space aim: player sits at fixed screen X, so world X advances with scroll
    const originX = e.x + e.w / 2;
    const originY = e.y + e.h * 0.4;
    const targetX = distance + player.x + player.w / 2;
    const targetY = player.y + player.h / 2;
    // Lead for player's effective forward motion through the world
    const leadX = targetX + speed * 0.18;
    const dx = leadX - originX;
    const dy = targetY - originY;
    const len = Math.hypot(dx, dy) || 1;
    const vx = (dx / len) * BULLET_SPEED;
    const vy = (dy / len) * BULLET_SPEED;

    bullets.push({
      x: originX,
      y: originY,
      vx,
      vy,
      r: 5,
    });

    // Muzzle flash (particles are screen-space)
    const sx = originX - distance;
    for (let i = 0; i < 4; i++) {
      particles.push({
        x: sx,
        y: originY,
        vx: rand(-40, 40) + (dx / len) * 60,
        vy: rand(-40, 40),
        life: rand(0.15, 0.35),
        max: 0.35,
        r: rand(2, 4),
        color: "rgba(255, 120, 80,",
      });
    }
  }

  function updateBullets(dt) {
    for (const b of bullets) {
      // World-space bullets: account for relative motion
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    bullets = bullets.filter((b) => {
      const sx = b.x - distance;
      return sx > -40 && sx < W + 80 && b.y > -40 && b.y < H + 40;
    });
  }

  // ── Themes & fireworks ────────────────────────────────────────
  function updateThemeAndMilestones() {
    const tier = Math.floor(score / THEME_INTERVAL);
    if (tier > lastThemeTier) {
      // Crossed a thousand mark
      lastThemeTier = tier;
      themeIndex = tier % THEMES.length;
      themeBlend = 0;
      fireworksQueue = 5 + Math.min(6, tier); // a few pops in the sky
      shake = Math.max(shake, 4);
    }
    if (themeBlend < 1) {
      themeBlend = Math.min(1, themeBlend + 0.015);
    }
  }

  function currentTheme() {
    return THEMES[themeIndex % THEMES.length];
  }

  function prevTheme() {
    const i = (themeIndex - 1 + THEMES.length) % THEMES.length;
    return THEMES[i];
  }

  function lerpColor(a, b, t) {
    // Only handles #rrggbb
    if (!a.startsWith("#") || !b.startsWith("#")) return t < 0.5 ? a : b;
    const parse = (hex) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const [ar, ag, ab] = parse(a);
    const [br, bg, bb] = parse(b);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return `rgb(${r},${g},${bl})`;
  }

  function themedSkyColors() {
    const t = themeBlend;
    const cur = currentTheme();
    const prev = prevTheme();
    if (t >= 0.99) return cur.sky;
    return cur.sky.map((c, i) => lerpColor(prev.sky[i], c, t));
  }

  function spawnFireworkBurst() {
    // Sky fireworks in background (screen space)
    const x = rand(W * 0.15, W * 0.85);
    const y = rand(30, 120);
    const colors = [
      "rgba(255, 80, 120,",
      "rgba(255, 200, 60,",
      "rgba(80, 220, 255,",
      "rgba(180, 100, 255,",
      "rgba(100, 255, 160,",
      "rgba(255, 140, 60,",
    ];
    const color = colors[(Math.random() * colors.length) | 0];
    const n = 22 + ((Math.random() * 12) | 0);
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n + rand(-0.1, 0.1);
      const sp = rand(60, 200);
      fireworks.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: rand(0.55, 1.1),
        max: 1.1,
        r: rand(1.5, 3.2),
        color,
        trail: Math.random() < 0.4,
      });
    }
    // Core flash
    fireworks.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0.2,
      max: 0.2,
      r: 10,
      color: "rgba(255, 255, 255,",
      trail: false,
    });
  }

  function updateFireworks(dt) {
    if (fireworksQueue > 0 && Math.random() < 0.08 + fireworksQueue * 0.02) {
      spawnFireworkBurst();
      fireworksQueue--;
    }
    for (const f of fireworks) {
      f.life -= dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += 50 * dt; // gentle fall
      f.vx *= 0.98;
    }
    fireworks = fireworks.filter((f) => f.life > 0);
  }

  // ── Game flow ─────────────────────────────────────────────────
  /** Put the square back on its feet - used by both the run and the idle menu. */
  /** Score and best each render twice - page HUD and in-canvas HUD. */
  function setScoreText(v) {
    const s = String(Math.floor(v));
    scoreEl.textContent = s;
    if (scoreElM) scoreElM.textContent = s;
  }

  function setBestText(v) {
    const s = String(Math.floor(v));
    bestEl.textContent = s;
    if (bestElM) bestElM.textContent = s;
    menuBestEl.textContent = s;
  }

  function resetPlayer() {
    Object.assign(player, {
      x: PLAYER_X,
      y: GROUND_Y - PLAYER_SIZE,
      vy: 0,
      onGround: true,
      coyote: COYOTE_TIME,
      jumpBuffer: 0,
      squish: 1,
      rotation: 0,
      dead: false,
      stompJumpGrace: 0,
    });
  }

  function startGame() {
    resetWorld();
    resetPlayer();
    // A shop loadout is the same promise the warp keys make: this run is for
    // fun, and it will not be written to the saved best.
    warped = shopModified();
    state = State.PLAYING;
    awaitingResume = false;
    releaseJump();
    closeFrontEnd();
    overlay.classList.add("hidden");
    setScoreText(0);
    setRunning(true);
    applyShopLoadout();
    syncResumeGate();
  }

  /**
   * Hand the run whatever was equipped in the shop. Order matters: the head
   * start rebuilds the world and clears powerups, so the permanent ones are
   * granted after it, never before.
   */
  function applyShopLoadout() {
    document.body.classList.toggle("is-modified", shopModified());
    if (!shopModified()) return;

    const head = shopHeadstart();
    if (head) warpToScore(head); // safe: state is already PLAYING

    steelHp = shopOn("steel") ? STEEL_HP : 0;
    steelFlash = 0;
    if (shopOn("forevergun")) grantPowerup("gun", { permanent: true });
    if (shopOn("fly")) grantPowerup("wings", { permanent: true });
  }

  /**
   * Inverse of the speed ramp: the run time that would have covered `d`.
   * distance = BASE_SPEED·t + SPEED_RAMP·t²/2 until the speed caps, then it
   * goes linear. Keeps a warped run scrolling as fast as an honest one - the
   * later enemies are only balanced at the speed they actually appear at.
   */
  function runTimeForDistance(d) {
    const tCap = (MAX_SPEED - BASE_SPEED) / SPEED_RAMP;
    const dCap = BASE_SPEED * tCap + (SPEED_RAMP * tCap * tCap) / 2;
    if (d <= dCap) {
      // Solve (SPEED_RAMP / 2)·t² + BASE_SPEED·t − d = 0
      return (
        (-BASE_SPEED + Math.sqrt(BASE_SPEED * BASE_SPEED + 2 * SPEED_RAMP * d)) / SPEED_RAMP
      );
    }
    return tCap + (d - dCap) / MAX_SPEED;
  }

  /**
   * Secret desktop shortcut (keys 1–5): jump the run to N thousand points so
   * the late enemy tiers can be tested without the climb.
   *
   * The world is rebuilt rather than extended: ensureWorld() only ever grows
   * forward, so bumping `distance` alone would generate - and then keep
   * iterating - hundreds of dead platforms behind the player.
   */
  function warpToScore(target) {
    if (state !== State.PLAYING) startGame();
    warped = true;

    distance = target * SCORE_TO_DIST;
    score = distance * 0.1;
    runTime = runTimeForDistance(distance);
    speed = Math.min(MAX_SPEED, BASE_SPEED + runTime * SPEED_RAMP);

    // Fresh world around the new position
    platforms = [];
    obstacles = [];
    signs = [];
    enemies = [];
    bullets = [];
    particles = [];
    fireworks = [];
    fireworksQueue = 0;
    clearPowerups();

    const runwayX = distance - 300;
    platforms.push({ x: runwayX, w: 800, y: GROUND_Y, h: H - GROUND_Y });
    let rightmost = runwayX + 800;
    while (rightmost < distance + SPAWN_AHEAD) {
      rightmost = spawnSegment(rightmost);
    }

    // Resume signs at the next milestone ahead, or ensureSigns() backfills
    // every 100-pt marker since zero in one go.
    nextSignValue = (Math.floor(score / SIGN_INTERVAL) + 1) * SIGN_INTERVAL;
    ensureSigns();

    lastThemeTier = Math.floor(score / THEME_INTERVAL);
    themeIndex = lastThemeTier % THEMES.length;
    themeBlend = 1;

    enemySpawnTimer = 0.4;
    hitInvuln = 0.5; // brief grace while the new stretch scrolls in

    // Drop the player back onto solid ice
    player.y = GROUND_Y - player.h;
    player.vy = 0;
    player.rotation = 0;
    player.squish = 1;
    player.onGround = true;
    player.coyote = COYOTE_TIME;
    player.jumpBuffer = 0;
    player.stompJumpGrace = 0;

    setScoreText(score);
    shake = Math.max(shake, 6);
  }

  /** Drives the in-canvas HUD's visibility (see .is-running in style.css). */
  function setRunning(on) {
    document.body.classList.toggle("is-running", on);
    if (hudMobile) hudMobile.setAttribute("aria-hidden", on ? "false" : "true");
  }

  function die(reason) {
    if (state !== State.PLAYING) return;
    state = State.DEAD;
    player.dead = true;
    shake = 10;
    spawnBurst(player.x + player.w / 2, player.y + player.h / 2, 18);

    awaitingResume = false;
    syncResumeGate();
    setRunning(false);

    // A warped run is a test run - it never overwrites the saved best.
    if (!warped && score > best) {
      best = score;
      localStorage.setItem("iceSlideBest", String(Math.floor(best)));
      setBestText(best);
    }

    overlayTitle.textContent = "You fell!";
    overlayMsg.innerHTML =
      `${reason}<br><br>Score: <strong style="color:#5ec8ff">${Math.floor(score)}</strong>` +
      (!warped && score >= best && score > 0 ? " - new best!" : "") +
      (shopModified()
        ? `<br><span class="msg-forfun">Shop run - the score doesn't count.</span>`
        : "");
    gameWrap.classList.add("game-wrap--menu");
    overlay.classList.remove("hidden");
  }

  // ── Victory (10,000) ──────────────────────────────────────────
  /**
   * The run is over and it was won. Everything that could still kill the
   * player is cleared, the scroll stops, and the square is planted on solid
   * ice - "stops on a platform" has to be literally true, so if the winning
   * step lands over a gap a slab is laid down under it.
   */
  function winRun() {
    if (state !== State.PLAYING) return;
    state = State.VICTORY;

    // Land exactly on the number, not 10,003.
    distance = WIN_SCORE * SCORE_TO_DIST;
    score = WIN_SCORE;
    setScoreText(score);
    speed = 0;

    enemies = [];
    bullets = [];
    clearPowerups();
    releaseJump();
    awaitingResume = false;
    syncResumeGate();

    victoryT = 0;
    victoryTitleY = VICTORY_TITLE_START;
    victoryTitleLanded = false;
    victoryDropTimer = 0;
    victoryDrops = [];
    fireworksQueue = 14;
    shake = Math.max(shake, 8);

    // Plant the square on solid ground
    const footX = distance + player.x;
    let stage = null;
    for (const p of platforms) {
      if (p.y < GROUND_Y - 1) continue;
      if (footX + player.w > p.x + 6 && footX < p.x + p.w - 6) {
        stage = p;
        break;
      }
    }
    if (!stage) {
      stage = { x: footX - 160, w: 420, y: GROUND_Y, h: H - GROUND_Y };
      platforms.push(stage);
    }
    player.y = stage.y - player.h;
    player.vy = 0;
    player.onGround = true;
    player.rotation = 0;
    player.squish = 1;
    player.dead = false;
    spawnDust(player.x + player.w / 2, stage.y);

    // 10,000 is the ceiling, so an honest win is always a best.
    if (!warped && score > best) {
      best = score;
      localStorage.setItem("iceSlideBest", String(Math.floor(best)));
    }
    setBestText(best);
  }

  /** Bounce-in easing so the banner lands rather than merely arriving. */
  function easeOutBounce(t) {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  }

  function updateVictory(dt) {
    victoryT += dt;

    // Keep the sky busy for as long as the player wants to sit and watch
    if (fireworksQueue < 4) fireworksQueue += 3;

    // Raiders raining out of the sky, shattering like fireworks
    victoryDropTimer -= dt;
    if (victoryDropTimer <= 0) {
      spawnVictoryDrop();
      victoryDropTimer = VICTORY_DROP_INTERVAL * rand(0.6, 1.5);
    }
    for (let i = victoryDrops.length - 1; i >= 0; i--) {
      const d = victoryDrops[i];
      // Gentle gravity: they have to be readable as raiders on the way down,
      // not just as the bang at the end.
      d.vy += 190 * dt;
      d.y += d.vy * dt;
      d.rot += d.spin * dt;
      if (d.y >= d.burstY) {
        shatterVictoryDrop(d);
        victoryDrops.splice(i, 1);
      }
    }

    // Banner descent
    const t = (victoryT - VICTORY_TITLE_DELAY) / VICTORY_TITLE_FALL;
    if (t <= 0) {
      victoryTitleY = VICTORY_TITLE_START;
    } else if (t < 1) {
      victoryTitleY =
        VICTORY_TITLE_START +
        (VICTORY_TITLE_REST - VICTORY_TITLE_START) * easeOutBounce(t);
    } else if (!victoryTitleLanded) {
      victoryTitleY = VICTORY_TITLE_REST;
      victoryTitleLanded = true;
      shake = Math.max(shake, 7);
      spawnDust(W * 0.5 - 90, VICTORY_TITLE_REST + 22);
      spawnDust(W * 0.5 + 90, VICTORY_TITLE_REST + 22);
    }

    // The square breathes on the spot
    player.squish += (1 - player.squish) * Math.min(1, dt * 10);
    if (shake > 0) shake = Math.max(0, shake - dt * 30);
  }

  function spawnVictoryDrop() {
    const ids = Object.keys(ENEMY_TYPES);
    const type = ids[(Math.random() * ids.length) | 0];
    const size = enemySizeOf(type);
    victoryDrops.push({
      type,
      x: rand(30, W - 30),
      y: -size - rand(0, 90),
      vy: rand(15, 55),
      size,
      rot: rand(-0.6, 0.6),
      spin: rand(-2.4, 2.4),
      // Weighted low so most of them go off down around the square rather
      // than in the far corner of the sky.
      burstY: GROUND_Y - 24 - Math.pow(Math.random(), 1.7) * (GROUND_Y - 130),
    });
  }

  /** One falling raider goes off like a firework shell, in its own colour. */
  function shatterVictoryDrop(d) {
    const color = getEnemyDef(d.type).fxColor;
    const n = 18 + ((Math.random() * 10) | 0);
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n + rand(-0.12, 0.12);
      const sp = rand(70, 230);
      fireworks.push({
        x: d.x,
        y: d.y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: rand(0.45, 0.95),
        max: 0.95,
        r: rand(1.6, 3.4),
        color,
        trail: Math.random() < 0.45,
      });
    }
    fireworks.push({
      x: d.x,
      y: d.y,
      vx: 0,
      vy: 0,
      life: 0.18,
      max: 0.18,
      r: 12,
      color: "rgba(255, 255, 255,",
      trail: false,
    });
  }

  // ── Physics & update ──────────────────────────────────────────
  function update(dt) {
    // Snow always drifts
    updateSnow(dt);
    updateParticles(dt);
    updateFireworks(dt);

    if (state !== State.PLAYING) {
      // Idle bob on menu
      if (state === State.MENU) {
        player.y = GROUND_Y - PLAYER_SIZE + Math.sin(performance.now() / 400) * 2;
      } else if (state === State.VICTORY) {
        updateVictory(dt);
      }
      return;
    }

    runTime += dt;
    speed = Math.min(MAX_SPEED, BASE_SPEED + runTime * SPEED_RAMP);
    distance += speed * dt;
    score = distance * 0.1;
    setScoreText(score);

    // The run has a finish line. Everything below is skipped once it's crossed.
    if (score >= WIN_SCORE) {
      winRun();
      return;
    }

    updateThemeAndMilestones();
    ensureWorld();
    updateEnemies(dt);
    updateBullets(dt);
    updatePowerups(dt); // gun may spawn friendly bullets this frame
    enforceShopPowerups(); // shop mods top their powerups back up
    resolveFriendlyBullets();
    if (steelFlash > 0) steelFlash = Math.max(0, steelFlash - dt);
    if (hitInvuln > 0) hitInvuln = Math.max(0, hitInvuln - dt);

    // Jump buffer / coyote
    if (jumpPressed) {
      player.jumpBuffer = JUMP_BUFFER;
      jumpPressed = false;
    }
    player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
    if (player.onGround) {
      player.coyote = COYOTE_TIME;
    } else {
      player.coyote = Math.max(0, player.coyote - dt);
    }

    if (player.jumpBuffer > 0 && player.coyote > 0) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
      player.squish = 0.72;
      player.stompJumpGrace = 0;
      skinOnJump();
      spawnDust(player.x + player.w / 2, player.y + player.h);
    }

    // Late Space right after a stomp still counts as a boost jump
    if (player.stompJumpGrace > 0) {
      player.stompJumpGrace = Math.max(0, player.stompJumpGrace - dt);
      if (player.jumpBuffer > 0) {
        applyStompBoost(null);
      }
    }

    // Wings: Space mid-air (after ground / coyote / stomp boost are exhausted)
    if (player.jumpBuffer > 0) {
      tryWingsJump();
    }

    // Variable jump height (also shortens a stomp-boost if you tap instead of hold)
    if (jumpReleased && player.vy < 0) {
      player.vy *= JUMP_CUT;
      jumpReleased = false;
    } else {
      jumpReleased = false;
    }

    // Gravity
    const g = player.vy > 0 ? FALL_GRAVITY : GRAVITY;
    player.vy += g * dt;
    player.y += player.vy * dt;

    // Squish recovery + spin in air
    player.squish += (1 - player.squish) * Math.min(1, dt * 12);
    if (!player.onGround) {
      player.rotation += speed * dt * 0.012;
    } else {
      player.rotation *= 0.85;
    }

    // Platform collision (AABB, land from above)
    player.onGround = false;
    const px = player.x;
    const py = player.y;
    const pw = player.w;
    const ph = player.h;
    const prevFeet = py + ph - player.vy * dt;

    // Stomp enemies from above first (squash + bounce) before platforms resolve
    let stompedThisFrame = false;
    if (player.vy >= 0) {
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        const ex = e.x - distance;
        if (ex + e.w < px - 4 || ex > px + pw + 4) continue;

        const overlappingX = px + pw > ex + 6 && px < ex + e.w - 6;
        const wasAbove = prevFeet <= e.y + 8;
        const feet = py + ph;
        const landingOnTop =
          feet >= e.y &&
          feet <= e.y + Math.max(16, Math.abs(player.vy) * dt + 12);

        if (overlappingX && wasAbove && landingOnTop) {
          // Spikes out = the head is a hazard, not a platform
          if (enemySpikesOut(e)) {
            if (playerTakeHit(getEnemyDef(e).hitReason)) return;
            // Absorbed - clear the enemy so the spikes can't chain-kill
            enemies.splice(i, 1);
            applyStompBounce(e.y);
            stompedThisFrame = true;
            break;
          }
          const top = e.y;
          stompEnemy(i, ex);
          applyStompBounce(top);
          stompedThisFrame = true;
          break; // one stomp per frame is enough
        }
      }
    }

    // Crates squash like enemies - same window, same bounce. Spikes never do.
    if (player.vy >= 0 && !stompedThisFrame) {
      for (let i = obstacles.length - 1; i >= 0; i--) {
        const o = obstacles[i];
        if (o.type !== "crate") continue;
        const ox = o.x - distance;
        if (ox + o.w < px - 4 || ox > px + pw + 4) continue;

        const overlappingX = px + pw > ox + 6 && px < ox + o.w - 6;
        const wasAbove = prevFeet <= o.y + 8;
        const feet = py + ph;
        const landingOnTop =
          feet >= o.y &&
          feet <= o.y + Math.max(16, Math.abs(player.vy) * dt + 12);

        if (overlappingX && wasAbove && landingOnTop) {
          const top = o.y;
          shatterObstacle(i, ox);
          applyStompBounce(top);
          stompedThisFrame = true;
          break;
        }
      }
    }

    for (const p of platforms) {
      const screenX = p.x - distance;
      // Only care about platforms under / near player horizontally
      if (screenX + p.w < px - 4 || screenX > px + pw + 4) continue;

      const wasAbove = prevFeet <= p.y + 2;
      const feet = player.y + ph;
      const overlappingX =
        px + pw > screenX + 4 && px < screenX + p.w - 4;

      if (
        overlappingX &&
        wasAbove &&
        feet >= p.y &&
        feet <= p.y + Math.max(12, Math.abs(player.vy) * dt + 8) &&
        player.vy >= 0
      ) {
        player.y = p.y - ph;
        player.vy = 0;
        player.onGround = true;
        if (Math.abs(player.rotation) > 0.4) {
          player.squish = 1.18;
          spawnDust(px + pw / 2, p.y);
        }
        player.rotation = 0;
      }
    }

    // Bridge: about to fall into a ground gap → place a plank and keep sliding
    if (!player.onGround) {
      tryDeployBridge();
    }

    // Obstacle hits (shield can absorb)
    for (let oi = obstacles.length - 1; oi >= 0; oi--) {
      const o = obstacles[oi];
      const ox = o.x - distance;
      if (rectsOverlap(px, player.y, pw, ph, ox, o.y, o.w, o.h)) {
        // Safety: clearly still on top of a crate while falling → treat as smash
        const feet = player.y + ph;
        const mostlyAbove =
          o.type === "crate" &&
          !stompedThisFrame &&
          player.vy >= 0 &&
          prevFeet <= o.y + 10 &&
          feet <= o.y + o.h * 0.45;
        if (mostlyAbove) {
          const top = o.y;
          shatterObstacle(oi, ox);
          applyStompBounce(top);
          stompedThisFrame = true;
          continue;
        }
        // The loop runs backwards, so a steel shell can splice the hazard it
        // just wrecked out from under itself without disturbing the walk.
        if (
          playerTakeHit(
            "You hit an ice hazard. Watch the spikes and crates!",
            () => shatterObstacle(oi, ox)
          )
        ) {
          return;
        }
        // Absorbed: nudge past this obstacle so we don't re-hit same frame
        // (obstacle still solid; brief invuln via powerup removal is enough)
      }
    }

    // Side / body hit only - stomping from above already handled
    for (let ei = enemies.length - 1; ei >= 0; ei--) {
      const e = enemies[ei];
      const ex = e.x - distance;
      if (!rectsOverlap(px, player.y, pw, ph, ex, e.y, e.w, e.h)) continue;

      const def = getEnemyDef(e);

      // Safety: if we're still clearly on top while falling, treat as stomp -
      // unless the spikes are out, in which case the head is never safe.
      const feet = player.y + ph;
      const mostlyAbove =
        player.vy >= 0 &&
        prevFeet <= e.y + 10 &&
        feet <= e.y + e.h * 0.45;
      if (mostlyAbove && !enemySpikesOut(e)) {
        const top = e.y;
        stompEnemy(ei, ex);
        applyStompBounce(top);
        continue;
      }

      if (def.lethalOnContact) {
        if (playerTakeHit(def.hitReason)) return;
        // Shield absorbed - knock enemy away so contact doesn't chain-kill
        enemies.splice(ei, 1);
      }
    }

    // Hostile bullet hits (player gun shots are friendly and never hurt the player)
    // Strip stray enemy bullets before gunners unlock; keep friendly shots alive.
    if (score < ENEMY_TYPES[EnemyKind.GUNNER].unlockScore) {
      bullets = bullets.filter((b) => b.friendly);
    }
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
      const b = bullets[bi];
      if (b.friendly) continue;
      const bx = b.x - distance;
      if (rectsOverlap(px, player.y, pw, ph, bx - b.r, b.y - b.r, b.r * 2, b.r * 2)) {
        bullets.splice(bi, 1);
        if (playerTakeHit("You got hit by a projectile! After 1000 pts, gunners shoot.")) {
          return;
        }
      }
    }

    // Live lazer beams. Not bullets: the beam is a static world-space band for
    // its 100ms, so it gets its own check rather than riding updateBullets().
    for (const e of enemies) {
      const beam = laserBeamRect(e);
      if (!beam) continue;
      if (rectsOverlap(px, player.y, pw, ph, beam.x - distance, beam.y, beam.w, beam.h)) {
        if (playerTakeHit(getEnemyDef(e).hitReason)) return;
        e.beamT = 0; // absorbed - kill the beam so it can't chain-hit
      }
    }

    // Fell into a pit / off the world
    if (player.y > H + 40) {
      die("You slid into the abyss. Jump the gaps!");
      return;
    }

    // Soft camera shake decay
    if (shake > 0) shake = Math.max(0, shake - dt * 30);
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // ── Particles & snow ──────────────────────────────────────────
  function initSnow() {
    snowflakes = [];
    for (let i = 0; i < 48; i++) {
      snowflakes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 2 + 0.6,
        vy: Math.random() * 30 + 18,
        vx: Math.random() * 20 - 10,
        a: Math.random() * 0.5 + 0.25,
      });
    }
  }

  function updateSnow(dt) {
    const wind = state === State.PLAYING ? -speed * 0.15 : -20;
    for (const s of snowflakes) {
      s.y += s.vy * dt;
      s.x += (s.vx + wind) * dt;
      if (s.y > H) {
        s.y = -4;
        s.x = Math.random() * W;
      }
      if (s.x < -10) s.x = W + 5;
      if (s.x > W + 10) s.x = -5;
    }
  }

  function spawnDust(x, y) {
    for (let i = 0; i < 6; i++) {
      particles.push({
        x,
        y,
        vx: rand(-60, 60),
        vy: rand(-80, -20),
        life: rand(0.25, 0.5),
        max: 0.5,
        r: rand(2, 4),
        color: "rgba(200, 230, 255,",
      });
    }
  }

  function spawnBurst(x, y, n) {
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(80, 280);
      particles.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: rand(0.3, 0.7),
        max: 0.7,
        r: rand(3, 6),
        color: "rgba(94, 200, 255,",
      });
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
    }
    particles = particles.filter((p) => p.life > 0);
  }

  // ── Drawing ───────────────────────────────────────────────────
  function draw() {
    // Re-stamped every frame: any canvas resize wipes the context state,
    // and this way the shake save/restore below can never desync it.
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    ctx.save();
    if (shake > 0) {
      ctx.translate(
        (Math.random() - 0.5) * shake,
        (Math.random() - 0.5) * shake
      );
    }

    drawBackground();
    drawFireworks();
    drawPlatforms();
    drawSigns();
    drawObstacles();
    drawEnemies();
    drawBullets();
    if (state === State.VICTORY) {
      drawVictoryDrops();
      // Before the player on purpose: the banner lands *behind* the square,
      // which is the one thing on screen that mustn't be covered up.
      drawVictoryTitle();
    }
    drawPlayer();
    if (steelHp > 0) drawSteelShell();
    drawPowerupOverlays();
    drawParticles();
    drawSnow();
    drawGroundGlow();

    ctx.restore();
  }

  /** The decorative raiders raining down during the finale. */
  function drawVictoryDrops() {
    for (const d of victoryDrops) {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      drawEnemyBody({
        type: d.type,
        w: d.size,
        h: d.size,
        bob: d.rot * 3,
        spikeT: 0,
        chargeT: 0,
        beamT: 0,
        chuting: false,
        skid: 0,
      });
      ctx.restore();
    }
  }

  /**
   * THANK YOU FOR PLAYING, dropped in from above the canvas and bounced onto
   * the floor beside the square. Nothing restarts the run until it lands -
   * see onJumpDown - so the celebration can never be mashed through.
   */
  function drawVictoryTitle() {
    const cx = W / 2;
    const y = victoryTitleY;
    const glow = 0.55 + Math.sin(performance.now() / 220) * 0.2;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Backing plate so the words survive the fireworks behind them
    ctx.font = "bold 38px system-ui, sans-serif";
    const w = Math.min(W - 40, ctx.measureText("THANK YOU FOR PLAYING").width + 56);
    ctx.fillStyle = "rgba(6, 20, 38, 0.55)";
    roundRect(cx - w / 2, y - 34, w, 68, 16);
    ctx.fill();
    ctx.strokeStyle = `rgba(150, 230, 255, ${0.3 + glow * 0.35})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = `rgba(120, 220, 255, ${glow})`;
    ctx.shadowBlur = 24;
    const g = ctx.createLinearGradient(0, y - 22, 0, y + 22);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.5, "#bfe9ff");
    g.addColorStop(1, "#5ec8ff");
    ctx.fillStyle = g;
    ctx.fillText("THANK YOU FOR PLAYING", cx, y);
    ctx.shadowBlur = 0;

    if (victoryTitleLanded) {
      ctx.font = "600 15px system-ui, sans-serif";
      ctx.fillStyle = `rgba(220, 240, 255, ${0.55 + glow * 0.45})`;
      ctx.fillText(
        isTouch ? "Tap to run again" : "Press SPACE to run again",
        cx,
        y - 54
      );
    }
    ctx.restore();
  }

  function drawBackground() {
    const sky = themedSkyColors();
    const theme = currentTheme();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, sky[0]);
    g.addColorStop(0.55, sky[1]);
    g.addColorStop(1, sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Distant mountains - the ridge tiles so it fills any W, and so the
    // parallax offset can't slide a bare patch of sky in from the right.
    ctx.fillStyle = theme.mountain;
    // Wrap on the ridge's own period, or the drift snaps mid-ridge and the
    // whole range jumps. distance is never negative, so this lands in
    // (-MOUNTAIN_PERIOD, 0] and the wrap is invisible.
    const drift = (-distance * 0.05) % MOUNTAIN_PERIOD;
    for (let off = drift; off <= W + 40; off += MOUNTAIN_PERIOD) {
      for (const m of MOUNTAIN_RIDGE) {
        const x = m.x + off;
        if (x > W + 40 || x + m.w < -40) continue;
        drawMountain(x, H - m.baseY, m.w, m.h, theme);
      }
    }

    // Aurora hint
    const aurora = ctx.createLinearGradient(0, 0, W, 80);
    aurora.addColorStop(0, theme.aurora[0]);
    aurora.addColorStop(0.4, theme.aurora[1]);
    aurora.addColorStop(0.7, theme.aurora[2]);
    aurora.addColorStop(1, theme.aurora[0]);
    ctx.fillStyle = aurora;
    ctx.fillRect(0, 0, W, 120);

    // Theme name flash when transitioning
    if (themeBlend < 0.85 && state === State.PLAYING && lastThemeTier > 0) {
      const a = Math.max(0, 1 - themeBlend / 0.85) * 0.7;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = "#e8f4ff";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(theme.name, W / 2, 36);
      ctx.restore();
    }
  }

  /** One repeating ridge span; x/baseY are offsets from the tile origin. */
  const MOUNTAIN_RIDGE = [
    { x: -40, baseY: 40, w: 180, h: 90 },
    { x: 160, baseY: 30, w: 220, h: 110 },
    { x: 420, baseY: 50, w: 200, h: 100 },
    { x: 680, baseY: 35, w: 240, h: 95 },
  ];
  const MOUNTAIN_PERIOD = 960; // the span the ridge above covers

  function drawMountain(x, baseY, w, h, theme) {
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + w * 0.45, baseY - h);
    ctx.lineTo(x + w, baseY);
    ctx.closePath();
    ctx.fill();
    // snow cap
    ctx.fillStyle = theme.snowCap;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.32, baseY - h * 0.55);
    ctx.lineTo(x + w * 0.45, baseY - h);
    ctx.lineTo(x + w * 0.62, baseY - h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = theme.mountain;
  }

  function drawFireworks() {
    for (const f of fireworks) {
      const a = Math.max(0, f.life / f.max);
      ctx.fillStyle = f.color + a + ")";
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fill();
      if (f.trail && a > 0.3) {
        ctx.strokeStyle = f.color + a * 0.4 + ")";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(f.x, f.y);
        ctx.lineTo(f.x - f.vx * 0.04, f.y - f.vy * 0.04);
        ctx.stroke();
      }
    }
  }

  function drawPlatforms() {
    const theme = currentTheme();
    for (const p of platforms) {
      const x = p.x - distance;
      if (x > W + 20 || x + p.w < -20) continue;

      const isMain = p.y >= GROUND_Y - 1;

      if (isMain) {
        if (p.isBridge) {
          // Wooden rescue bridge filling a gap
          const wood = ctx.createLinearGradient(0, p.y, 0, p.y + 28);
          wood.addColorStop(0, "#f0d090");
          wood.addColorStop(0.35, "#c89840");
          wood.addColorStop(1, "#6a4820");
          ctx.fillStyle = wood;
          ctx.fillRect(x, p.y, p.w, Math.min(p.h, 36));
          // Plank seams
          ctx.strokeStyle = "rgba(60, 35, 10, 0.4)";
          ctx.lineWidth = 1.5;
          for (let i = 10; i < p.w; i += 14) {
            ctx.beginPath();
            ctx.moveTo(x + i, p.y);
            ctx.lineTo(x + i, p.y + 34);
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(255, 230, 160, 0.55)";
          ctx.fillRect(x, p.y, p.w, 3);
          // Support posts into the void
          ctx.fillStyle = "rgba(50, 30, 10, 0.55)";
          ctx.fillRect(x + 4, p.y + 34, 5, 22);
          ctx.fillRect(x + p.w - 9, p.y + 34, 5, 22);
        } else {
          // Deep ice slab
          const ice = ctx.createLinearGradient(0, p.y, 0, H);
          ice.addColorStop(0, theme.iceTop);
          ice.addColorStop(0.15, theme.iceMid);
          ice.addColorStop(1, theme.iceDeep);
          ctx.fillStyle = ice;
          ctx.fillRect(x, p.y, p.w, p.h);

          // Glossy top edge
          ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
          ctx.fillRect(x, p.y, p.w, 4);
          ctx.fillStyle = "rgba(160, 220, 255, 0.35)";
          ctx.fillRect(x, p.y + 4, p.w, 6);

          // Crack / texture lines
          ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
          ctx.lineWidth = 1;
          for (let i = 30; i < p.w; i += 48) {
            ctx.beginPath();
            ctx.moveTo(x + i, p.y + 8);
            ctx.lineTo(x + i + 12, p.y + 28);
            ctx.stroke();
          }

          // Cliff faces at gap edges
          ctx.fillStyle = "rgba(10, 30, 50, 0.45)";
          ctx.fillRect(x, p.y, 3, p.h);
          ctx.fillRect(x + p.w - 3, p.y, 3, p.h);
        }
      } else {
        // Floating ice platform
        roundRect(x, p.y, p.w, p.h, 6);
        const fg = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
        fg.addColorStop(0, "#e8f6ff");
        fg.addColorStop(1, theme.iceMid);
        ctx.fillStyle = fg;
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillRect(x + 4, p.y + 2, p.w - 8, 3);
      }
    }

    // Abyss under gaps - subtle void
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, GROUND_Y + 4, W, H - GROUND_Y);
  }

  function drawSigns() {
    for (const s of signs) {
      const x = s.x - distance;
      if (x < -50 || x > W + 50) continue;

      const isThousand = s.value % THEME_INTERVAL === 0;
      const boardW = isThousand ? 58 : 48;
      const boardH = 28;

      if (s.floating) {
        drawFloatingBubbleSign(x, s, boardW, boardH, isThousand);
      } else {
        drawPlantedSign(x, s, boardW, boardH, isThousand);
      }
    }
  }

  function drawPlantedSign(x, s, boardW, boardH, isThousand) {
    const postH = 52;
    const postX = x;
    const postTop = GROUND_Y - postH;

    // Shadow on ice
    ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
    ctx.beginPath();
    ctx.ellipse(postX + 2, GROUND_Y + 2, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Wooden post stuck into ice
    const postGrad = ctx.createLinearGradient(postX - 3, postTop, postX + 5, GROUND_Y);
    postGrad.addColorStop(0, "#8b6914");
    postGrad.addColorStop(1, "#5a4010");
    ctx.fillStyle = postGrad;
    ctx.fillRect(postX - 3, postTop, 6, postH + 6);

    // Ice crust around post base (stuck in)
    ctx.fillStyle = "rgba(200, 230, 255, 0.7)";
    ctx.beginPath();
    ctx.ellipse(postX, GROUND_Y + 1, 10, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    drawSignBoard(postX, postTop + 2, boardW, boardH, s.value, isThousand);

    // Small frost icicle under board
    const bx = postX - boardW / 2;
    const by = postTop + 2;
    ctx.fillStyle = "rgba(180, 220, 255, 0.55)";
    ctx.beginPath();
    ctx.moveTo(bx + 8, by + boardH);
    ctx.lineTo(bx + 12, by + boardH + 8);
    ctx.lineTo(bx + 16, by + boardH);
    ctx.fill();
  }

  function drawFloatingBubbleSign(x, s, boardW, boardH, isThousand) {
    // Bob gently in mid-air over the gap (time-based)
    const bobY = Math.sin(performance.now() / 450 + s.bob) * 5;
    const cy = GROUND_Y - 88 + bobY;
    const bubbleR = Math.max(boardW, boardH) * 0.72 + 10;

    // Soft drop shadow into the abyss
    ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
    ctx.beginPath();
    ctx.ellipse(x, GROUND_Y + 6, bubbleR * 0.55, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Translucent ice bubble
    const bubble = ctx.createRadialGradient(
      x - bubbleR * 0.25,
      cy - bubbleR * 0.3,
      2,
      x,
      cy,
      bubbleR
    );
    bubble.addColorStop(0, "rgba(220, 245, 255, 0.55)");
    bubble.addColorStop(0.55, "rgba(140, 200, 240, 0.28)");
    bubble.addColorStop(1, "rgba(80, 150, 200, 0.12)");
    ctx.beginPath();
    ctx.arc(x, cy, bubbleR, 0, Math.PI * 2);
    ctx.fillStyle = bubble;
    ctx.fill();
    ctx.strokeStyle = "rgba(200, 235, 255, 0.65)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Shine arc on bubble
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, cy, bubbleR * 0.72, -Math.PI * 0.85, -Math.PI * 0.45);
    ctx.stroke();

    // Sign board floating inside
    drawSignBoard(x, cy - boardH / 2, boardW, boardH, s.value, isThousand);

    // Tiny sparkle dots
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.beginPath();
    ctx.arc(x - bubbleR * 0.35, cy - bubbleR * 0.4, 2, 0, Math.PI * 2);
    ctx.arc(x + bubbleR * 0.4, cy + bubbleR * 0.15, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSignBoard(cx, by, boardW, boardH, value, isThousand) {
    const bx = cx - boardW / 2;
    roundRect(bx, by, boardW, boardH, 4);
    if (isThousand) {
      const bg = ctx.createLinearGradient(bx, by, bx, by + boardH);
      bg.addColorStop(0, "#ffd060");
      bg.addColorStop(1, "#d08020");
      ctx.fillStyle = bg;
    } else {
      const bg = ctx.createLinearGradient(bx, by, bx, by + boardH);
      bg.addColorStop(0, "#f0e0b0");
      bg.addColorStop(1, "#c8a860");
      ctx.fillStyle = bg;
    }
    ctx.fill();
    ctx.strokeStyle = "rgba(60, 40, 10, 0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = isThousand ? "#3a2000" : "#2a2010";
    ctx.font = `bold ${isThousand ? 13 : 12}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, by + boardH / 2 + 1);
  }

  function drawObstacles() {
    for (const o of obstacles) {
      const x = o.x - distance;
      if (x > W + 20 || x + o.w < -20) continue;

      if (o.type === "spike") {
        ctx.fillStyle = "#9ad0ef";
        ctx.beginPath();
        ctx.moveTo(x, o.y + o.h);
        ctx.lineTo(x + o.w / 2, o.y);
        ctx.lineTo(x + o.w, o.y + o.h);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.beginPath();
        ctx.moveTo(x + o.w * 0.35, o.y + o.h * 0.55);
        ctx.lineTo(x + o.w / 2, o.y + 4);
        ctx.lineTo(x + o.w * 0.55, o.y + o.h * 0.55);
        ctx.closePath();
        ctx.fill();
        // Danger tint
        ctx.fillStyle = "rgba(255, 100, 120, 0.25)";
        ctx.beginPath();
        ctx.moveTo(x, o.y + o.h);
        ctx.lineTo(x + o.w / 2, o.y);
        ctx.lineTo(x + o.w, o.y + o.h);
        ctx.closePath();
        ctx.fill();
      } else {
        // Crate / ice block
        roundRect(x, o.y, o.w, o.h, 4);
        const cg = ctx.createLinearGradient(x, o.y, x, o.y + o.h);
        cg.addColorStop(0, "#b8d8f0");
        cg.addColorStop(1, "#4a7a98");
        ctx.fillStyle = cg;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = "rgba(20, 50, 70, 0.35)";
        ctx.beginPath();
        ctx.moveTo(x + 6, o.y + 6);
        ctx.lineTo(x + o.w - 6, o.y + o.h - 6);
        ctx.moveTo(x + o.w - 6, o.y + 6);
        ctx.lineTo(x + 6, o.y + o.h - 6);
        ctx.stroke();
      }
    }
  }

  function drawEnemies() {
    for (const e of enemies) {
      const x = e.x - distance;
      if (x > W + 40 || x + e.w < -40) continue;

      const bobY = Math.sin(e.bob) * 1.5;
      const cx = x + e.w / 2;
      const cy = e.y + e.h / 2 + bobY;

      ctx.save();
      ctx.translate(cx, cy);

      // Soft shadow (shared)
      ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
      ctx.beginPath();
      ctx.ellipse(0, e.h / 2 + 3, e.w * 0.42, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      drawEnemyBody(e);

      ctx.restore();
    }

    // Beams live in screen space across the whole lane, so they can't be drawn
    // inside the per-enemy translate above. Painted last: on top of everything.
    drawLaserBeams();
  }

  /**
   * The lazer raider's aim line (during the wind-up) and the beam itself.
   * The aim line is deliberately the loud part - it's the second of warning
   * the player actually gets - while the beam is a hard white flash.
   */
  function drawLaserBeams() {
    for (const e of enemies) {
      if (!getEnemyDef(e).beam) continue;
      // No bob here on purpose: this is the line laserBeamRect() kills along,
      // and the drawn streak has to be exactly the rectangle that hurts.
      const cy = e.y + e.h * 0.5;
      const originX = e.x - distance - e.w / 2 - 13;
      if (originX < -40 || originX > W + 60) continue;

      if (e.chargeT > 0) {
        // Aim line: thin, dashed and building in brightness
        const charge = 1 - e.chargeT / LASER_CHARGE;
        ctx.save();
        ctx.globalAlpha = 0.25 + charge * 0.55;
        ctx.strokeStyle = "#ff6ce0";
        ctx.lineWidth = 1 + charge * 1.5;
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -(performance.now() / 14) % 18;
        ctx.beginPath();
        ctx.moveTo(originX, cy);
        ctx.lineTo(Math.max(-20, originX - LASER_RANGE), cy);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const beam = laserBeamRect(e);
      if (!beam) continue;
      const bx = beam.x - distance;
      const fade = e.beamT / LASER_BEAM; // 1 → 0 across the 100ms
      const h = beam.h;

      const g = ctx.createLinearGradient(0, beam.y, 0, beam.y + h);
      g.addColorStop(0, "rgba(255, 130, 240, 0)");
      g.addColorStop(0.5, `rgba(255, 255, 255, ${0.65 + fade * 0.35})`);
      g.addColorStop(1, "rgba(255, 130, 240, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(bx, beam.y - h * 0.6, beam.w, h * 2.2);

      ctx.fillStyle = `rgba(255, 255, 255, ${0.8 + fade * 0.2})`;
      ctx.fillRect(bx, beam.y + h * 0.32, beam.w, h * 0.36);

      // Muzzle flare at the emitter
      const flare = ctx.createRadialGradient(originX, cy, 0, originX, cy, 26);
      flare.addColorStop(0, `rgba(255, 255, 255, ${0.85 * fade})`);
      flare.addColorStop(1, "rgba(255, 90, 220, 0)");
      ctx.fillStyle = flare;
      ctx.beginPath();
      ctx.arc(originX, cy, 26, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Type → art. Add a case here when registering a new ENEMY_TYPES entry.
   * Called with the canvas already translated to the enemy's center.
   */
  function drawEnemyBody(e) {
    switch (e.type) {
      case EnemyKind.DROPPER:
        return drawEnemyDropper(e);
      case EnemyKind.GUNNER:
        return drawEnemyRaiderBody(e, true);
      case EnemyKind.FLYER:
        return drawEnemyFlyer(e);
      case EnemyKind.SPIKER:
        return drawEnemySpiker(e);
      case EnemyKind.BRUTE:
        return drawEnemyBrute(e);
      case EnemyKind.FROST:
        return drawEnemyFrost(e);
      case EnemyKind.LASER:
        return drawEnemyLaser(e);
      case EnemyKind.SLIDER:
        return drawEnemySlider(e);
      case EnemyKind.COMMANDO:
        return drawEnemyCommando(e);
      case EnemyKind.ULTIMATE:
        return drawEnemyUltimate(e);
      default:
        return drawEnemyRaiderBody(e, false);
    }
  }

  /**
   * Shared angry-square shell for the recolored variants.
   * pal = [highlight, mid, shadow]; ink = brows / mouth; glint = pupil spark.
   */
  function drawRaiderShell(e, pal, ink, glint) {
    const body = ctx.createLinearGradient(-e.w / 2, -e.h / 2, e.w / 2, e.h / 2);
    body.addColorStop(0, pal[0]);
    body.addColorStop(0.45, pal[1]);
    body.addColorStop(1, pal[2]);
    roundRect(-e.w / 2, -e.h / 2, e.w, e.h, 5);
    ctx.fillStyle = body;
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    roundRect(-e.w / 2 + 4, -e.h / 2 + 4, e.w * 0.4, 7, 3);
    ctx.fill();

    // Angry brows
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-10, -10);
    ctx.lineTo(-3, -6);
    ctx.moveTo(10, -10);
    ctx.lineTo(3, -6);
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(-6, -3, 3.2, 0, Math.PI * 2);
    ctx.arc(6, -3, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = glint;
    ctx.beginPath();
    ctx.arc(-5, -3.5, 1.1, 0, Math.PI * 2);
    ctx.arc(7, -3.5, 1.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, 8);
    ctx.quadraticCurveTo(0, 3, 7, 8);
    ctx.stroke();
  }

  /**
   * Head spikes, drawn *above* the body rect so they never change the
   * hitbox - enemySpikesOut() alone decides whether a stomp lands.
   * extend is the same 0..1 the stomp rule reads.
   */
  function drawHeadSpikes(e, extend, fill, shadow) {
    const top = -e.h / 2;

    // Socket plate: reads as the slot the spikes retract into
    ctx.fillStyle = shadow;
    roundRect(-e.w * 0.44, top - 1, e.w * 0.88, 4, 2);
    ctx.fill();

    if (extend <= 0.02) return;

    const n = 4;
    const span = e.w * 0.84;
    const len = e.h * 0.4 * extend;
    const half = (span / n) * 0.42;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const cx = -span / 2 + (span * (i + 0.5)) / n;
      ctx.moveTo(cx - half, top + 1);
      ctx.lineTo(cx, top - len);
      ctx.lineTo(cx + half, top + 1);
      ctx.closePath();
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = shadow;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Purple winged raider - flies over gaps, still stompable. */
  function drawEnemyFlyer(e) {
    const flap = Math.sin(e.bob * 2.2);
    const span = e.w * 0.72;
    const lift = flap * e.h * 0.22;

    ctx.fillStyle = "rgba(226, 200, 255, 0.92)";
    ctx.strokeStyle = "rgba(110, 60, 175, 0.8)";
    ctx.lineWidth = 1.5;
    for (const dir of [-1, 1]) {
      const tipX = dir * (e.w / 2 + span);
      ctx.beginPath();
      ctx.moveTo(dir * (e.w / 2 - 3), -6);
      // Sweep up and out, then back along a shallower trailing edge
      ctx.quadraticCurveTo(dir * (e.w / 2 + span * 0.5), -20 + lift, tipX, -6 + lift * 1.2);
      ctx.quadraticCurveTo(dir * (e.w / 2 + span * 0.4), 5, dir * (e.w / 2 - 3), 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Single membrane rib so the wing doesn't read as a solid blob
      ctx.beginPath();
      ctx.moveTo(dir * (e.w / 2 - 2), -3);
      ctx.quadraticCurveTo(dir * (e.w / 2 + span * 0.55), -6 + lift, tipX, -5 + lift * 1.2);
      ctx.stroke();
    }

    drawRaiderShell(e, ["#d9a6ff", "#9b46e0", "#571a8e"], "#1e0733", "#ffd6f5");
  }

  /** Blue spiker - head spikes cycle out (1s) and in (1s). */
  function drawEnemySpiker(e) {
    const extend = enemySpikeExtend(e);
    drawRaiderShell(e, ["#8fd8ff", "#2f86e0", "#123f7a"], "#04172e", "#c8f0ff");
    drawHeadSpikes(e, extend, "#dff2ff", "rgba(8, 40, 80, 0.85)");

    // Warning glow while the spikes are actually lethal
    if (extend > 0.5) {
      ctx.fillStyle = `rgba(200, 240, 255, ${0.25 * extend})`;
      ctx.beginPath();
      ctx.ellipse(0, -e.h / 2 - 6, e.w * 0.5, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** White spiker - same spikes, permanently out. Never stompable. */
  function drawEnemyFrost(e) {
    drawRaiderShell(e, ["#ffffff", "#dfe9f5", "#9aa9bd"], "#2b3a4d", "#7fd8ff");
    drawHeadSpikes(e, 1, "#ffffff", "rgba(90, 110, 140, 0.9)");
  }

  /** Black brute - 2×2 raider with shining red eyes. */
  function drawEnemyBrute(e) {
    const s = e.w / ENEMY_SIZE_BIG; // art is authored at full 68px
    const pulse = 0.75 + Math.sin(e.bob * 1.6) * 0.25;

    const body = ctx.createLinearGradient(-e.w / 2, -e.h / 2, e.w / 2, e.h / 2);
    body.addColorStop(0, "#4a4a58");
    body.addColorStop(0.45, "#1c1c24");
    body.addColorStop(1, "#050508");
    roundRect(-e.w / 2, -e.h / 2, e.w, e.h, 9 * s);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = "rgba(160, 60, 60, 0.35)";
    ctx.lineWidth = 2 * s;
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.1)";
    roundRect(-e.w / 2 + 7 * s, -e.h / 2 + 7 * s, e.w * 0.38, 9 * s, 4 * s);
    ctx.fill();

    // Cracks
    ctx.strokeStyle = "rgba(200, 60, 50, 0.25)";
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.moveTo(-e.w * 0.34, e.h * 0.12);
    ctx.lineTo(-e.w * 0.12, e.h * 0.26);
    ctx.lineTo(-e.w * 0.2, e.h * 0.42);
    ctx.moveTo(e.w * 0.3, -e.h * 0.02);
    ctx.lineTo(e.w * 0.14, e.h * 0.18);
    ctx.stroke();

    // Heavy brow
    ctx.strokeStyle = "#0a0a0e";
    ctx.lineWidth = 6 * s;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-e.w * 0.34, -e.h * 0.3);
    ctx.lineTo(-e.w * 0.08, -e.h * 0.16);
    ctx.moveTo(e.w * 0.34, -e.h * 0.3);
    ctx.lineTo(e.w * 0.08, -e.h * 0.16);
    ctx.stroke();

    // Shining red eyes
    for (const dir of [-1, 1]) {
      const ex = dir * e.w * 0.2;
      const ey = -e.h * 0.06;
      const glow = ctx.createRadialGradient(ex, ey, 0, ex, ey, 13 * s);
      glow.addColorStop(0, `rgba(255, 70, 60, ${0.75 * pulse})`);
      glow.addColorStop(1, "rgba(255, 40, 30, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ex, ey, 13 * s, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ff3320";
      ctx.beginPath();
      ctx.arc(ex, ey, 5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffd0c0";
      ctx.beginPath();
      ctx.arc(ex - 1.4 * s, ey - 1.4 * s, 2 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // Jagged grin
    ctx.strokeStyle = "#0a0a0e";
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(-e.w * 0.24, e.h * 0.22);
    for (let i = 0; i < 5; i++) {
      const x = -e.w * 0.24 + (e.w * 0.48 * (i + 1)) / 5;
      ctx.lineTo(x, e.h * (i % 2 === 0 ? 0.3 : 0.22));
    }
    ctx.stroke();
  }

  /** Regular / gunner red angry square. gun=true draws a blaster. */
  function drawEnemyRaiderBody(e, gun) {
    const body = ctx.createLinearGradient(-e.w / 2, -e.h / 2, e.w / 2, e.h / 2);
    if (gun) {
      body.addColorStop(0, "#ff6a5a");
      body.addColorStop(0.45, "#d02030");
      body.addColorStop(1, "#701018");
    } else {
      body.addColorStop(0, "#ff7a6a");
      body.addColorStop(0.45, "#e83840");
      body.addColorStop(1, "#9a1820");
    }
    roundRect(-e.w / 2, -e.h / 2, e.w, e.h, 5);
    ctx.fillStyle = body;
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    roundRect(-e.w / 2 + 4, -e.h / 2 + 4, e.w * 0.4, 7, 3);
    ctx.fill();

    // Angry brows
    ctx.strokeStyle = "#2a0808";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-10, -10);
    ctx.lineTo(-3, -6);
    ctx.moveTo(10, -10);
    ctx.lineTo(3, -6);
    ctx.stroke();

    ctx.fillStyle = "#1a0505";
    ctx.beginPath();
    ctx.arc(-6, -3, 3.2, 0, Math.PI * 2);
    ctx.arc(6, -3, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = gun ? "#ff8844" : "#ffcc44";
    ctx.beginPath();
    ctx.arc(-5, -3.5, 1.1, 0, Math.PI * 2);
    ctx.arc(7, -3.5, 1.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#2a0808";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, 8);
    ctx.quadraticCurveTo(0, 3, 7, 8);
    ctx.stroke();

    if (gun) {
      ctx.fillStyle = "#3a3a48";
      ctx.fillRect(-e.w / 2 - 10, -2, 12, 7);
      ctx.fillStyle = "#6a6a78";
      ctx.fillRect(-e.w / 2 - 14, 0, 6, 3);
      ctx.fillStyle = "rgba(255, 100, 60, 0.85)";
      ctx.beginPath();
      ctx.arc(-e.w / 2 - 14, 1.5, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Lazer raider - magenta shell with a barrel emitter on its leading side.
   * The barrel swells and the core whitens through the charge, so the tell is
   * on the sprite itself as well as in the aim line drawn by drawLaserBeams().
   */
  function drawEnemyLaser(e) {
    const charge = e.chargeT > 0 ? 1 - e.chargeT / LASER_CHARGE : 0;
    const firing = e.beamT > 0;

    drawRaiderShell(e, ["#ffa8f0", "#c02fa8", "#5d0a55"], "#2a0026", "#ffe4fb");

    // Dorsal capacitor fins - they light up as the shot builds
    ctx.fillStyle = firing
      ? "rgba(255, 255, 255, 0.95)"
      : `rgba(255, 130, 235, ${0.35 + charge * 0.6})`;
    for (const dx of [-8, 0, 8]) {
      roundRect(dx - 2.5, -e.h / 2 - 5 - charge * 3, 5, 6 + charge * 3, 2);
      ctx.fill();
    }

    // Emitter barrel, pointing back down the lane at the player
    const bx = -e.w / 2 - 13;
    ctx.fillStyle = "#3d1038";
    roundRect(bx, -4, 15, 8, 2);
    ctx.fill();
    ctx.fillStyle = "#7c2b70";
    ctx.fillRect(bx + 2, -2.5, 11, 2);

    // Muzzle core: a pinprick at rest, a white-hot bulb at the moment of fire
    const r = firing ? 6.5 : 2 + charge * 4;
    const glow = ctx.createRadialGradient(bx, 0, 0, bx, 0, r * 2.6);
    glow.addColorStop(0, firing ? "rgba(255,255,255,0.95)" : `rgba(255, 110, 235, ${0.5 + charge * 0.5})`);
    glow.addColorStop(1, "rgba(255, 60, 200, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(bx, 0, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = firing ? "#ffffff" : "#ff7ae0";
    ctx.beginPath();
    ctx.arc(bx, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Ice raider - cyan raider at double speed. The read has to happen fast, so
   * the speed is drawn as well as felt: a frozen skid streak trailing off the
   * back edge and a spray of chips kicked up off the ice.
   */
  function drawEnemySlider(e) {
    const skid = e.skid == null ? 1 : e.skid;

    // Skid streak - it trails behind, i.e. to the right of the leftward charge
    if (skid > 0.02) {
      const len = e.w * (1.1 + skid * 1.5);
      const streak = ctx.createLinearGradient(e.w / 2, 0, e.w / 2 + len, 0);
      streak.addColorStop(0, `rgba(150, 245, 255, ${0.55 * skid})`);
      streak.addColorStop(1, "rgba(150, 245, 255, 0)");
      ctx.fillStyle = streak;
      for (const off of [-7, 2, 9]) {
        const h = 3.5 - Math.abs(off) * 0.12;
        roundRect(e.w / 2 - 2, off - h / 2, len, h, h / 2);
        ctx.fill();
      }

      // Chips off the ice at its feet
      ctx.fillStyle = `rgba(215, 250, 255, ${0.5 * skid})`;
      for (let i = 0; i < 4; i++) {
        const px = e.w / 2 + 3 + ((e.bob * 37 + i * 23) % (e.w * 1.2));
        const py = e.h / 2 - 2 - ((i * 7 + e.bob * 11) % 12);
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawRaiderShell(e, ["#d6feff", "#2ec6e6", "#0b5f86"], "#062534", "#ffffff");

    // Frozen rime along the leading edge
    ctx.fillStyle = "rgba(235, 255, 255, 0.65)";
    roundRect(-e.w / 2 - 1, -e.h / 2 + 6, 3.5, e.h - 12, 1.75);
    ctx.fill();
  }

  /**
   * Commando raider - olive shell, knife clenched in its teeth, and a canopy
   * overhead while it is still falling. The chute is drawn above the body rect
   * so it never changes what the stomp check sees.
   */
  function drawEnemyCommando(e) {
    const sway = Math.sin(e.bob * 0.55) * 0.16;

    if (e.chuting) {
      ctx.save();
      ctx.rotate(sway);
      const canopyY = -e.h / 2 - 34;
      const rx = e.w * 0.95;

      // Cords
      ctx.strokeStyle = "rgba(240, 245, 255, 0.75)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const dx of [-1, -0.45, 0.45, 1]) {
        ctx.moveTo(dx * (e.w * 0.34), -e.h / 2 + 2);
        ctx.lineTo(dx * rx * 0.86, canopyY + 6);
      }
      ctx.stroke();

      // Canopy - three panels so it reads as fabric, not a bowl
      const panels = [
        ["#f2f6ff", "#b9c6dc"],
        ["#e8402f", "#9d1c14"],
        ["#f2f6ff", "#b9c6dc"],
      ];
      for (let i = 0; i < 3; i++) {
        const a0 = Math.PI + (Math.PI * i) / 3;
        const a1 = Math.PI + (Math.PI * (i + 1)) / 3;
        const g = ctx.createLinearGradient(0, canopyY - 18, 0, canopyY + 8);
        g.addColorStop(0, panels[i][0]);
        g.addColorStop(1, panels[i][1]);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, canopyY + 4);
        ctx.ellipse(0, canopyY + 4, rx, 20, 0, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(40, 60, 90, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, canopyY + 4, rx, 20, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawRaiderShell(e, ["#b8cf8a", "#6f8f42", "#31461a"], "#131c08", "#eaffc0");

    // Field cap over the brows
    ctx.fillStyle = "#435622";
    roundRect(-e.w / 2 + 1, -e.h / 2 - 3, e.w - 2, 7, 2);
    ctx.fill();
    ctx.fillStyle = "#5d7530";
    roundRect(-e.w / 2 - 4, -e.h / 2 + 2, 11, 3, 1.5);
    ctx.fill();

    // Knife clenched in its teeth - blade out to the leading side
    ctx.save();
    ctx.translate(0, 7.5);
    ctx.fillStyle = "#3a2a18";
    roundRect(4, -1.8, 9, 3.6, 1.6);
    ctx.fill();
    ctx.fillStyle = "#8f6a3a";
    ctx.fillRect(2.5, -2.6, 2, 5.2);
    const blade = ctx.createLinearGradient(-14, 0, 2, 0);
    blade.addColorStop(0, "#ffffff");
    blade.addColorStop(0.5, "#cfe0ee");
    blade.addColorStop(1, "#8fa3b5");
    ctx.fillStyle = blade;
    ctx.beginPath();
    ctx.moveTo(2, -2.4);
    ctx.lineTo(-13, -1.2);
    ctx.lineTo(-13, 1);
    ctx.lineTo(2, 2.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Ultimate Raider - the 9000+ boss read: gold body, white burning eyes and a
   * radiating aura, airborne and armed. Everything here is additive glow, so
   * the silhouette stays a plain square and the stomp target stays honest.
   */
  function drawEnemyUltimate(e) {
    const pulse = 0.7 + Math.sin(e.bob * 1.4) * 0.3;

    // Radiating aura - the god-cube halo
    const aura = ctx.createRadialGradient(0, 0, e.w * 0.35, 0, 0, e.w * (1.15 + pulse * 0.18));
    aura.addColorStop(0, `rgba(255, 236, 170, ${0.42 * pulse})`);
    aura.addColorStop(0.55, `rgba(255, 190, 60, ${0.2 * pulse})`);
    aura.addColorStop(1, "rgba(255, 170, 30, 0)");
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, e.w * (1.15 + pulse * 0.18), 0, Math.PI * 2);
    ctx.fill();

    // Rays, slowly turning
    ctx.save();
    ctx.rotate(e.bob * 0.16);
    ctx.strokeStyle = `rgba(255, 245, 200, ${0.3 * pulse})`;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      const r0 = e.w * 0.72;
      const r1 = r0 + (i % 2 === 0 ? 11 : 6) * (0.7 + pulse * 0.5);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();

    // Golden shell
    const body = ctx.createLinearGradient(-e.w / 2, -e.h / 2, e.w / 2, e.h / 2);
    body.addColorStop(0, "#fff4c2");
    body.addColorStop(0.35, "#ffd24a");
    body.addColorStop(0.72, "#e09a14");
    body.addColorStop(1, "#8a5606");
    roundRect(-e.w / 2, -e.h / 2, e.w, e.h, 6);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 250, 210, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    roundRect(-e.w / 2 + 4, -e.h / 2 + 4, e.w * 0.42, 6, 3);
    ctx.fill();

    // Crown notches
    ctx.fillStyle = "#ffe9a0";
    for (const dx of [-10, 0, 10]) {
      ctx.beginPath();
      ctx.moveTo(dx - 4, -e.h / 2);
      ctx.lineTo(dx, -e.h / 2 - 6);
      ctx.lineTo(dx + 4, -e.h / 2);
      ctx.closePath();
      ctx.fill();
    }

    // Brows, kept dark so the white eyes read as light and not as holes
    ctx.strokeStyle = "#6b4304";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-11, -11);
    ctx.lineTo(-3, -7);
    ctx.moveTo(11, -11);
    ctx.lineTo(3, -7);
    ctx.stroke();

    // Burning white eyes
    for (const dir of [-1, 1]) {
      const ex = dir * 6;
      const ey = -2.5;
      const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, 11);
      g.addColorStop(0, `rgba(255, 255, 255, ${0.95 * pulse})`);
      g.addColorStop(0.4, `rgba(255, 250, 220, ${0.45 * pulse})`);
      g.addColorStop(1, "rgba(255, 240, 180, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ex, ey, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(ex, ey, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "#6b4304";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, 9);
    ctx.quadraticCurveTo(0, 4, 7, 9);
    ctx.stroke();

    // Golden blaster
    ctx.fillStyle = "#b8860b";
    ctx.fillRect(-e.w / 2 - 11, -2, 13, 7);
    ctx.fillStyle = "#ffe08a";
    ctx.fillRect(-e.w / 2 - 15, 0, 7, 3);
    ctx.fillStyle = `rgba(255, 255, 235, ${0.7 + pulse * 0.3})`;
    ctx.beginPath();
    ctx.arc(-e.w / 2 - 15, 1.5, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Yellow powerup dropper with a "?" mark - stomp to grant a powerup. */
  function drawEnemyDropper(e) {
    const body = ctx.createLinearGradient(-e.w / 2, -e.h / 2, e.w / 2, e.h / 2);
    body.addColorStop(0, "#ffe66a");
    body.addColorStop(0.45, "#ffc820");
    body.addColorStop(1, "#d09010");
    roundRect(-e.w / 2, -e.h / 2, e.w, e.h, 6);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 70, 0, 0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Soft shine
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    roundRect(-e.w / 2 + 4, -e.h / 2 + 4, e.w * 0.45, 7, 3);
    ctx.fill();

    // Question mark
    ctx.fillStyle = "#5a3008";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 0, 2);

    // Friendly eyes peeking (optional charm)
    ctx.fillStyle = "rgba(90, 48, 8, 0.35)";
    ctx.beginPath();
    ctx.arc(-8, -8, 2, 0, Math.PI * 2);
    ctx.arc(8, -8, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBullets() {
    for (const b of bullets) {
      const x = b.x - distance;
      if (x < -20 || x > W + 20) continue;

      if (b.friendly) {
        const glow = ctx.createRadialGradient(x, b.y, 0, x, b.y, b.r * 3);
        glow.addColorStop(0, "rgba(120, 255, 180, 0.55)");
        glow.addColorStop(1, "rgba(40, 200, 120, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, b.y, b.r * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#a8ffc8";
        ctx.beginPath();
        ctx.arc(x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x - 1, b.y - 1, b.r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Hostile glow
        const glow = ctx.createRadialGradient(x, b.y, 0, x, b.y, b.r * 3);
        glow.addColorStop(0, "rgba(255, 160, 80, 0.55)");
        glow.addColorStop(1, "rgba(255, 80, 40, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, b.y, b.r * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#ffd080";
        ctx.beginPath();
        ctx.arc(x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x - 1, b.y - 1, b.r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * The square. The shell here - transform, shadow, death tint, eyes, trail -
   * is shared by every skin; only the surface art is swapped (see SKIN_DEFS),
   * so squish, rotation and every powerup overlay keep working unchanged.
   */
  function drawPlayer() {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const sx = player.squish;
    const sy = 2 - player.squish;
    const skin = activeSkin();
    const t = performance.now() / 1000;
    const w = player.w;
    const h = player.h;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(player.rotation);
    ctx.scale(sx, sy);

    // Soft shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    ctx.beginPath();
    ctx.ellipse(0, player.h / 2 + 4, player.w * 0.45, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Death is the one frame every skin shares. Costumes come off: the
    // red square is a gameplay signal, and it must never be ambiguous.
    if (player.dead) {
      const body = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      body.addColorStop(0, "#ff8a9a");
      body.addColorStop(1, "#c04050");
      roundRect(-w / 2, -h / 2, w, h, 6);
      ctx.fillStyle = body;
      ctx.fill();
      skinShine(w, h);
    } else {
      if (skin.behind) skin.behind(w, h, t);
      skin.body(w, h, t);
      if (skin.features) skin.features(w, h, t);
    }

    if (state === State.VICTORY) {
      // It made it. The eyes come round off the profile line to face you,
      // and the square finally smiles. Costume stays on - it earned it.
      drawVictoryFace();
    } else if (player.dead || skin.eyes !== false) {
      ctx.fillStyle = "#0a1a12";
      ctx.beginPath();
      ctx.arc(4, -4, 3.5, 0, Math.PI * 2);
      ctx.arc(14, -4, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(5, -5, 1.2, 0, Math.PI * 2);
      ctx.arc(15, -5, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Motion trail when fast
    if (state === State.PLAYING && speed > 320 && player.onGround) {
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = skin.trail;
      for (let i = 1; i <= 3; i++) {
        ctx.fillRect(
          player.x - i * 10,
          player.y + 4,
          player.w * 0.7,
          player.h - 8
        );
      }
      ctx.globalAlpha = 1;
    }
  }

  /**
   * The winner's face: centred eyes (the run pose has them shoved right, in
   * profile) and a wide grin. Drawn inside drawPlayer's transform.
   */
  function drawVictoryFace() {
    const blink = Math.sin(performance.now() / 900);
    const lid = blink > 0.965 ? 0.25 : 1; // occasional slow blink

    ctx.fillStyle = "#0a1a12";
    for (const dx of [-7, 7]) {
      ctx.beginPath();
      ctx.ellipse(dx, -5, 3.6, 3.6 * lid, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (lid > 0.5) {
      ctx.fillStyle = "#fff";
      for (const dx of [-6, 8]) {
        ctx.beginPath();
        ctx.arc(dx, -6.2, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Grin
    ctx.strokeStyle = "#0a1a12";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 3, 8, 0.24 * Math.PI, 0.76 * Math.PI);
    ctx.stroke();

    // Happy cheeks
    ctx.fillStyle = "rgba(255, 130, 150, 0.4)";
    for (const dx of [-12, 12]) {
      ctx.beginPath();
      ctx.ellipse(dx, 2, 3.4, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color + a + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * a, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSnow() {
    for (const s of snowflakes) {
      ctx.fillStyle = `rgba(220, 235, 255, ${s.a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGroundGlow() {
    // Subtle horizon line
    ctx.strokeStyle = "rgba(120, 190, 230, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(W, GROUND_Y);
    ctx.stroke();
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  // ══════════════════════════════════════════════════════════════
  // FRONT END - entrance screen & field manual
  // ──────────────────────────────────────────────────────────────
  // The entrance screen is a DOM layer over the canvas, so the live idle
  // world (sky, aurora, mountains, snow, bobbing square) keeps running as
  // its backdrop. The manual is a modal, and every row's icon is painted
  // by the *game's own* draw functions onto a tiny canvas - so the art in
  // the instructions can never drift from the art in the run.
  // ══════════════════════════════════════════════════════════════
  const ICON_SIZE = 62; // CSS px - matches .entry-icon in style.css

  /** @type {{ctx:CanvasRenderingContext2D, kind:string}[]} */
  const manualIcons = [];

  /** Point every draw helper at another canvas for the duration of fn(). */
  function withCtx(target, fn) {
    const prev = ctx;
    ctx = target;
    try {
      fn();
    } finally {
      ctx = prev;
    }
  }

  function blurUi() {
    const el = document.activeElement;
    if (el && typeof el.blur === "function") el.blur();
  }

  // ── Manual content (generated from the gameplay registries) ───
  function unlockTag(unlockScore) {
    return unlockScore > 0 ? `${unlockScore}+ pts` : "from the start";
  }

  function durationTag(def) {
    return def.duration > 0 ? `${def.duration}s` : "held till used";
  }

  function buildManual() {
    const enemies = Object.values(ENEMY_TYPES)
      .slice()
      .sort((a, b) => a.unlockScore - b.unlockScore)
      .map((t) => ({
        kind: t.id,
        name: t.name,
        tag: unlockTag(t.unlockScore),
        tagClass: "entry-tag--danger",
        desc: t.desc,
      }));

    const hazards = HAZARD_INFO.map((h) => ({
      kind: h.icon,
      name: h.name,
      tag: h.tag,
      tagClass: "",
      desc: h.desc,
    }));

    const powerups = POWERUP_DROP_IDS.filter((id) => POWERUP_DEFS[id]).map((id) => {
      const def = POWERUP_DEFS[id];
      return {
        kind: `powerup:${id}`,
        name: def.name || def.label,
        tag: durationTag(def),
        tagClass: "entry-tag--gold",
        desc: def.desc || "",
      };
    });

    renderEntries(document.getElementById("list-enemies"), enemies.concat(hazards));
    renderEntries(document.getElementById("list-powerups"), powerups);
  }

  /** Manual copy names the jump input by the one this device actually has. */
  function jumpWord(text) {
    return text.replace(/\{\{JUMP\}\}/g, isTouch ? "TAP" : "SPACE");
  }

  function renderEntries(list, rows) {
    if (!list) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "entry";

      const icon = document.createElement("canvas");
      icon.className = "entry-icon";
      icon.width = Math.round(ICON_SIZE * dpr);
      icon.height = Math.round(ICON_SIZE * dpr);
      icon.setAttribute("aria-hidden", "true");
      const ictx = icon.getContext("2d");
      ictx.scale(dpr, dpr); // draw in CSS pixels, render crisp on retina

      const body = document.createElement("div");
      body.className = "entry-body";
      body.innerHTML =
        `<div class="entry-head">` +
        `<span class="entry-name"></span>` +
        `<span class="entry-tag ${row.tagClass}"></span>` +
        `</div><p class="entry-desc">${jumpWord(row.desc)}</p>`;
      body.querySelector(".entry-name").textContent = row.name;
      body.querySelector(".entry-tag").textContent = row.tag;

      li.append(icon, body);
      list.append(li);
      manualIcons.push({ ctx: ictx, kind: row.kind });
    }
  }

  // ── Skins screen (cards painted by the real player sprite) ────
  const SKIN_TILE = 96; // CSS px - matches .skin-stage in style.css

  /** @type {{ctx:CanvasRenderingContext2D, id:string, card:HTMLElement}[]} */
  const skinCards = [];

  function buildSkins() {
    const grid = document.getElementById("skin-grid");
    if (!grid) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    for (const id of SKIN_ORDER) {
      const def = SKIN_DEFS[id];
      if (!def) continue;

      const card = document.createElement("button");
      card.type = "button";
      card.className = "skin-card";
      card.dataset.skin = id;
      card.style.setProperty("--skin-accent", def.accent);

      const stage = document.createElement("span");
      stage.className = "skin-stage";
      stage.setAttribute("aria-hidden", "true");

      const cv = document.createElement("canvas");
      cv.className = "skin-canvas";
      cv.width = Math.round(SKIN_TILE * dpr);
      cv.height = Math.round(SKIN_TILE * dpr);
      const cctx = cv.getContext("2d");
      cctx.scale(dpr, dpr); // draw in CSS pixels, render crisp on retina
      stage.append(cv);

      const meta = document.createElement("span");
      meta.className = "skin-meta";
      meta.innerHTML =
        `<span class="skin-name"></span>` +
        `<span class="skin-tag"></span>` +
        `<span class="skin-blurb"></span>`;
      meta.querySelector(".skin-name").textContent = def.name;
      meta.querySelector(".skin-tag").textContent = def.tag;
      meta.querySelector(".skin-blurb").textContent = def.blurb;

      const stateEl = document.createElement("span");
      stateEl.className = "skin-state";
      stateEl.innerHTML =
        `<span class="skin-state-off">Equip</span>` +
        `<span class="skin-state-on"><span class="skin-check" aria-hidden="true">✓</span>Equipped</span>`;

      card.append(stage, meta, stateEl);
      card.addEventListener("click", () => selectSkin(id, card));
      grid.append(card);
      skinCards.push({ ctx: cctx, id, card });
    }
    syncSkinCards();
  }

  function selectSkin(id, card) {
    if (id === "dice") rollDice(); // show off the gimmick on equip
    equipSkin(id);
    syncSkinCards();
    // Only ever one popped card - the class carries the equipped glow, so a
    // stale one left on the previous pick would leave two cards breathing.
    for (const entry of skinCards) entry.card.classList.remove("skin-card--pop");
    void card.offsetWidth; // reflow, so tapping the same card pops again
    card.classList.add("skin-card--pop");
  }

  function syncSkinCards() {
    for (const entry of skinCards) {
      const on = entry.id === equippedSkin;
      entry.card.classList.toggle("skin-card--on", on);
      entry.card.setAttribute("aria-pressed", on ? "true" : "false");
      entry.card.setAttribute(
        "aria-label",
        `${SKIN_DEFS[entry.id].name}${on ? " — equipped" : ""}`
      );
    }
  }

  /** Each card paints its own skin with the live game sprite. */
  function drawSkinPreviews() {
    for (let i = 0; i < skinCards.length; i++) {
      withCtx(skinCards[i].ctx, () => drawSkinPreview(skinCards[i].id, i));
    }
  }

  function drawSkinPreview(id, index) {
    const S = SKIN_TILE;
    ctx.clearRect(0, 0, S, S);

    const def = SKIN_DEFS[id];
    const bob = Math.sin(performance.now() / 620 + index * 0.8) * 3;

    // Accent pedestal so each square sits in its own pool of light
    const glow = ctx.createRadialGradient(S / 2, S * 0.62, 3, S / 2, S * 0.62, S * 0.48);
    glow.addColorStop(0, hexAlpha(def.accent, 0.22));
    glow.addColorStop(1, hexAlpha(def.accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);

    const saved = {
      x: player.x,
      y: player.y,
      squish: player.squish,
      rotation: player.rotation,
      dead: player.dead,
    };
    previewSkin = id;
    player.x = (S - PLAYER_SIZE) / 2;
    player.y = (S - PLAYER_SIZE) / 2 + bob;
    player.squish = 1;
    player.rotation = 0;
    player.dead = false;

    drawPlayer();

    previewSkin = null;
    Object.assign(player, saved);
  }

  /** #rrggbb → rgba(). Skin accents are always plain hex. */
  function hexAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ── Shop screen (cards painted by the real game art) ──────────
  const SHOP_TILE = 84; // CSS px - matches .shop-stage in style.css
  const SHOP_CHIP_W = 64; // matches .shop-chip-canvas
  const SHOP_CHIP_H = 50;

  /** @type {{ctx:CanvasRenderingContext2D, id:string, card:HTMLElement,
   *   w:number, h:number}[]} */
  const shopCards = [];
  let shopSummaryEl = null;

  function buildShop() {
    const chips = document.getElementById("shop-chips");
    const grid = document.getElementById("shop-grid");
    if (!chips || !grid) return;
    shopSummaryEl = document.getElementById("shop-summary");
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    for (const id of SHOP_ORDER) {
      const def = SHOP_DEFS[id];
      const isStart = def.group === "start";
      const w = isStart ? SHOP_CHIP_W : SHOP_TILE;
      const h = isStart ? SHOP_CHIP_H : SHOP_TILE;

      const card = document.createElement("button");
      card.type = "button";
      card.className = isStart ? "shop-chip" : "shop-card";
      card.dataset.item = id;
      card.style.setProperty("--shop-accent", def.accent);

      const stage = document.createElement("span");
      stage.className = isStart ? "shop-chip-stage" : "shop-stage";
      stage.setAttribute("aria-hidden", "true");

      const cv = document.createElement("canvas");
      cv.className = isStart ? "shop-chip-canvas" : "shop-canvas";
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const cctx = cv.getContext("2d");
      cctx.scale(dpr, dpr); // draw in CSS pixels, render crisp on retina
      stage.append(cv);

      if (isStart) {
        const tick = document.createElement("span");
        tick.className = "shop-chip-tick";
        tick.setAttribute("aria-hidden", "true");
        tick.textContent = "✓";
        card.append(stage, tick);
      } else {
        const meta = document.createElement("span");
        meta.className = "shop-meta";
        meta.innerHTML =
          `<span class="shop-name"></span>` +
          `<span class="shop-tag"></span>` +
          `<span class="shop-blurb"></span>`;
        meta.querySelector(".shop-name").textContent = def.name;
        meta.querySelector(".shop-tag").textContent = def.tag;
        meta.querySelector(".shop-blurb").textContent = def.blurb;

        const stateEl = document.createElement("span");
        stateEl.className = "shop-state";
        stateEl.innerHTML =
          `<span class="shop-state-off">Equip</span>` +
          `<span class="shop-state-on"><span class="shop-check" aria-hidden="true">✓</span>Equipped</span>`;

        card.append(stage, meta, stateEl);
      }

      card.addEventListener("click", () => pickShopItem(id, card));
      (isStart ? chips : grid).append(card);
      shopCards.push({ ctx: cctx, id, card, w, h });
    }

    syncShopCards();
  }

  function pickShopItem(id, card) {
    toggleShopItem(id);
    syncShopCards();
    // Only ever one popped card, exactly as in the wardrobe: the class
    // carries the pop, so a stale one would leave two cards bouncing.
    for (const entry of shopCards) entry.card.classList.remove("shop-card--pop");
    if (shopOn(id)) {
      void card.offsetWidth; // reflow, so re-picking the same card pops again
      card.classList.add("shop-card--pop");
    }
  }

  function syncShopCards() {
    for (const entry of shopCards) {
      const def = SHOP_DEFS[entry.id];
      const on = shopOn(entry.id);
      entry.card.classList.toggle("shop-card--on", on);
      entry.card.setAttribute("aria-pressed", on ? "true" : "false");
      entry.card.setAttribute(
        "aria-label",
        `${def.full || def.name}${on ? " — equipped" : ""}`
      );
    }

    const clear = document.getElementById("btn-clear-shop");
    if (clear) clear.disabled = !shopModified();

    if (!shopSummaryEl) return;
    const n = shopEquipped.size;
    shopSummaryEl.textContent = n
      ? `${n} equipped — this run is just for fun.`
      : "Nothing equipped — your next run counts.";
    shopSummaryEl.classList.toggle("shop-summary--hot", n > 0);
  }

  function drawShopPreviews() {
    for (const entry of shopCards) {
      withCtx(entry.ctx, () => drawShopIcon(entry.id, entry.w, entry.h));
    }
  }

  function drawShopIcon(id, w, h) {
    ctx.clearRect(0, 0, w, h);
    const def = SHOP_DEFS[id];
    if (!def) return;

    if (def.group === "start") {
      drawHeadstartIcon(def.headstart, w, h);
      return;
    }
    if (id === "nogaps") drawNoGapsIcon(w);
    else if (id === "dropper2") drawDoubleDropperIcon(w);
    else if (id === "steel") drawSteelIcon(w);
    else if (id === "forevergun") drawForeverIcon(w, "gun");
    else if (id === "fly") drawForeverIcon(w, "wings");
  }

  /** A milestone sign, planted - the same board the run plants every 100 pts. */
  function drawHeadstartIcon(value, w, h) {
    const cx = w / 2;
    const base = h - 5;
    const boardH = 25;
    const boardW = 52;
    const bob = Math.sin(performance.now() / 700) * 1;

    // Shadow on the ice
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(cx + 1, base + 1, 11, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Post
    const post = ctx.createLinearGradient(cx - 3, base - 30, cx + 3, base);
    post.addColorStop(0, "#8b6914");
    post.addColorStop(1, "#5a4010");
    ctx.fillStyle = post;
    ctx.fillRect(cx - 2.5, base - 30, 5, 30);

    // Ice crust where it's driven in
    ctx.fillStyle = "rgba(200, 230, 255, 0.7)";
    ctx.beginPath();
    ctx.ellipse(cx, base, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    drawSignBoard(cx, base - 30 - boardH + 6 + bob, boardW, boardH, value, true);
  }

  /**
   * The exact opposite of the manual's "gap" tile: where that one is two
   * ledges with the void between them, this is one ledge running clean off
   * both edges. Nothing is added in the middle on purpose - any marker there
   * reads as an object standing on the ice rather than as unbroken ice.
   */
  function drawNoGapsIcon(S) {
    const ledgeH = 21;
    const groundY = S - ledgeH - 4;
    const t = performance.now();

    drawManualLedge(-4, groundY, S + 8, ledgeH);

    // Frost glints tracking across the surface, so the slab still breathes
    for (let i = 0; i < 3; i++) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t / 520 + i * 2.1));
      const gx = S * (0.14 + i * 0.36);
      drawSparkStar(gx, groundY - 4, 3.2 * tw, `rgba(220, 246, 255, ${0.25 + tw * 0.45})`);
    }

    // The square, sliding straight across it
    const saved = {
      x: player.x, y: player.y, squish: player.squish,
      rotation: player.rotation, dead: player.dead,
    };
    ctx.save();
    ctx.translate(S / 2, groundY - 12);
    ctx.scale(0.62, 0.62);
    player.x = -PLAYER_SIZE / 2;
    player.y = -PLAYER_SIZE / 2;
    player.squish = 1;
    player.rotation = 0;
    player.dead = false;
    drawPlayer();
    ctx.restore();
    Object.assign(player, saved);
  }

  /** Two ? boxes, because that is exactly what the mod does. */
  function drawDoubleDropperIcon(S) {
    const t = performance.now();
    const make = (phase) => ({
      w: ENEMY_SIZE,
      h: ENEMY_SIZE,
      type: EnemyKind.DROPPER,
      bob: t / 400 + phase,
      spikeT: 0,
      chargeT: 0,
      beamT: 0,
      skid: 1,
    });

    // Back box first, a shade smaller so the pair reads as depth
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.translate(S * 0.62, S * 0.4 + Math.sin(t / 520) * 2);
    ctx.scale(0.56, 0.56);
    drawEnemyBody(make(1.4));
    ctx.restore();

    ctx.save();
    ctx.translate(S * 0.4, S * 0.56 + Math.sin(t / 430) * 2);
    ctx.scale(0.72, 0.72);
    drawEnemyBody(make(0));
    ctx.restore();

    // ×2 stamp
    ctx.fillStyle = "rgba(255, 200, 32, 0.95)";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("×2", S - 5, S - 4);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  /** The square in its shell - the live drawSteelShell, mid-damage. */
  function drawSteelIcon(S) {
    const saved = {
      x: player.x, y: player.y, squish: player.squish,
      rotation: player.rotation, dead: player.dead,
    };
    const savedHp = steelHp;
    const savedFlash = steelFlash;
    const bob = Math.sin(performance.now() / 600) * 1.5;

    steelHp = 7; // three cracks: enough to show what a hit costs
    steelFlash = 0;
    player.x = (S - PLAYER_SIZE) / 2;
    player.y = (S - PLAYER_SIZE) / 2 + 4 + bob;
    player.squish = 1;
    player.rotation = 0;
    player.dead = false;

    drawPlayer();
    drawSteelShell();

    steelHp = savedHp;
    steelFlash = savedFlash;
    Object.assign(player, saved);
  }

  /** A powerup that never runs out: the sprite wearing it, plus the ∞. */
  function drawForeverIcon(S, id) {
    const def = POWERUP_DEFS[id];
    if (!def) return;

    const saved = {
      x: player.x, y: player.y, squish: player.squish,
      rotation: player.rotation, dead: player.dead,
    };
    const bob = Math.sin(performance.now() / 600) * 1.5;

    player.x = (S - PLAYER_SIZE) / 2 - (id === "gun" ? 7 : 0);
    player.y = (S - PLAYER_SIZE) / 2 + bob;
    player.squish = 1;
    player.rotation = 0;
    player.dead = false;

    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.scale(0.88, 0.88);
    ctx.translate(-S / 2, -S / 2);
    drawPlayer();
    // Infinity keeps the overlay solid - these two never blink out.
    const fake = { id, remaining: Infinity, def };
    if (id === "gun") drawGunOverlay(fake);
    else drawWingsOverlay(fake);
    ctx.restore();

    Object.assign(player, saved);

    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.font = "bold 17px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("∞", S - 5, S - 3);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  // ── Manual icon art (reuses the in-game draw functions) ───────
  function drawManualIcons() {
    for (const icon of manualIcons) {
      withCtx(icon.ctx, () => drawManualIcon(icon.kind));
    }
  }

  function drawManualIcon(kind) {
    const S = ICON_SIZE;
    ctx.clearRect(0, 0, S, S);

    if (kind.startsWith("powerup:")) {
      drawPowerupIcon(kind.slice(8), S);
      return;
    }
    if (kind === "gap" || kind === "spike" || kind === "crate") {
      drawHazardIcon(kind, S);
      return;
    }
    drawEnemyIcon(kind, S);
  }

  function drawEnemyIcon(kind, S) {
    const t = performance.now();
    const bob = Math.sin(t / 420) * 2;
    // Every type is drawn at ENEMY_SIZE here - the 68px brute wouldn't fit the
    // 62px tile, so its scale is described in the copy instead of the art.
    const e = {
      w: ENEMY_SIZE,
      h: ENEMY_SIZE,
      type: kind,
      bob: t / 400,
      // Icons animate their spike cycle just like the live enemy
      spikeT: (t / 1000) % SPIKE_CYCLE,
      // The lazer icon loops its wind-up so the tile shows the tell, not the beam
      chargeT: kind === EnemyKind.LASER ? LASER_CHARGE * (((t / 1400) % 1)) : 0,
      beamT: 0,
      // Commandos are only ever recognisable with the canopy up
      chuting: kind === EnemyKind.COMMANDO,
      skid: 1,
    };
    // Blaster-carrying types hang a barrel off their left side - nudge right
    const cx =
      S / 2 + (kind === EnemyKind.GUNNER || kind === EnemyKind.ULTIMATE ? 6 : 0);
    // Wings, chutes and auras reach past the body (pull in); the brute reads
    // as a slab (push out).
    const scale =
      kind === EnemyKind.FLYER
        ? 0.68
        : kind === EnemyKind.BRUTE
          ? 1.35
          : kind === EnemyKind.COMMANDO
            ? 0.58
            : kind === EnemyKind.ULTIMATE
              ? 0.7
              : kind === EnemyKind.LASER || kind === EnemyKind.SLIDER
                ? 0.86
                : 1;

    // The chute sits well above the body - drop the whole rig to centre it
    const yNudge =
      kind === EnemyKind.SPIKER || kind === EnemyKind.FROST
        ? 5
        : kind === EnemyKind.COMMANDO
          ? 12
          : 0;

    ctx.save();
    ctx.translate(cx, S / 2 + bob + yNudge);
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(0, e.h / 2 + 8 - bob, e.w * 0.42, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.scale(scale, scale);
    drawEnemyBody(e);

    ctx.restore();
  }

  /** Player-relative overlays: park the square where the whole effect fits. */
  const POWERUP_ICON_POS = {
    shield: { x: 13, y: 13 },
    wings: { x: 13, y: 16 },
    gun: { x: 4, y: 15 },
    bridge: { x: 13, y: 23 },
  };

  function drawPowerupIcon(id, S) {
    const def = POWERUP_DEFS[id];
    const pos = POWERUP_ICON_POS[id];
    if (!def || !pos) return;

    const saved = {
      x: player.x,
      y: player.y,
      vy: player.vy,
      squish: player.squish,
      rotation: player.rotation,
      dead: player.dead,
    };
    const bob = Math.sin(performance.now() / 560) * 1.5;

    player.x = pos.x;
    player.y = pos.y + bob;
    player.squish = 1;
    player.rotation = 0;
    player.dead = false;

    // Soft pedestal glow so the sprite reads on the frosted tile
    const glow = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S * 0.5);
    glow.addColorStop(0, "rgba(120, 220, 255, 0.12)");
    glow.addColorStop(1, "rgba(120, 220, 255, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);

    // The whole composition shrinks a touch about the tile centre, so a skin
    // with horns still fits inside the shield bubble and inside the tile.
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.scale(0.86, 0.86);
    ctx.translate(-S / 2, -S / 2);

    drawPlayer();
    // Timed powerups blink near expiry - Infinity keeps the icon solid.
    const fake = { id, remaining: Infinity, def };
    if (id === "shield") drawShieldBubble(fake);
    else if (id === "wings") drawWingsOverlay(fake);
    else if (id === "gun") drawGunOverlay(fake);
    else if (id === "bridge") drawBridgeOverlay(fake);
    ctx.restore();

    Object.assign(player, saved);
  }

  /** A slice of ice slab, painted like the real platforms. */
  function drawManualLedge(x, y, w, h) {
    const theme = currentTheme();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, theme.iceMid);
    g.addColorStop(0.45, theme.iceMid);
    g.addColorStop(1, theme.iceDeep);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.fillRect(x, y, w, 2.5);
    ctx.fillStyle = "rgba(160, 220, 255, 0.35)";
    ctx.fillRect(x, y + 2.5, w, 3);
    ctx.fillStyle = "rgba(10, 30, 50, 0.45)";
    ctx.fillRect(x, y, 2, h);
    ctx.fillRect(x + w - 2, y, 2, h);
  }

  /** One ice shard, painted with the obstacle palette from drawObstacles(). */
  function drawManualSpike(x, baseY, w, h, tint) {
    const y = baseY - h;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
    };

    ctx.fillStyle = "#9ad0ef";
    path();
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.beginPath();
    ctx.moveTo(x + w * 0.35, y + h * 0.55);
    ctx.lineTo(x + w / 2, y + 3);
    ctx.lineTo(x + w * 0.55, y + h * 0.55);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(255, 100, 120, ${tint})`;
    path();
    ctx.fill();
  }

  function drawHazardIcon(kind, S) {
    const ledgeH = 15;
    const groundY = S - ledgeH;
    const t = performance.now();

    if (kind === "gap") {
      const ledge = 17;
      drawManualLedge(0, groundY, ledge, ledgeH);
      drawManualLedge(S - ledge, groundY, ledge, ledgeH);
      // The void between them
      const abyss = ctx.createLinearGradient(0, groundY - 2, 0, S);
      abyss.addColorStop(0, "rgba(0, 0, 0, 0.62)");
      abyss.addColorStop(1, "rgba(0, 0, 0, 0.12)");
      ctx.fillStyle = abyss;
      ctx.fillRect(ledge, groundY - 2, S - ledge * 2, ledgeH + 2);

      // The square, mid-hop over the gap (same sprite, scaled down)
      const hop = Math.abs(Math.sin(t / 620));
      const saved = { x: player.x, y: player.y, squish: player.squish, rotation: player.rotation, dead: player.dead };
      ctx.save();
      ctx.translate(S / 2, groundY - 12 - hop * 13);
      ctx.scale(0.58, 0.58);
      player.x = -PLAYER_SIZE / 2;
      player.y = -PLAYER_SIZE / 2;
      player.squish = 1 - hop * 0.12;
      player.rotation = 0;
      player.dead = false;
      drawPlayer();
      ctx.restore();
      Object.assign(player, saved);
      return;
    }

    drawManualLedge(0, groundY, S, ledgeH);

    if (kind === "spike") {
      // A cluster reads better at icon size than a single shard
      const pulse = 0.14 + 0.12 * Math.abs(Math.sin(t / 700));
      drawManualSpike(16, groundY, 16, 19, pulse);
      drawManualSpike(33, groundY, 14, 26, pulse);
      return;
    }

    // Crate
    const size = 24;
    const x = (S - size) / 2;
    const y = groundY - size;
    roundRect(x, y, size, size, 4);
    const cg = ctx.createLinearGradient(x, y, x, y + size);
    cg.addColorStop(0, "#b8d8f0");
    cg.addColorStop(1, "#4a7a98");
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(20, 50, 70, 0.35)";
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 5);
    ctx.lineTo(x + size - 5, y + size - 5);
    ctx.moveTo(x + size - 5, y + 5);
    ctx.lineTo(x + 5, y + size - 5);
    ctx.stroke();
  }

  // ── Screen transitions ────────────────────────────────────────
  function showMenu() {
    state = State.MENU;
    menuView = "home";
    resetWorld();
    resetPlayer();
    // The death jolt keeps rattling through the game-over screen on purpose -
    // it only stops here, when the player steps back out to the menu.
    shake = 0;
    awaitingResume = false;
    releaseJump();
    setRunning(false);
    syncResumeGate();
    setScoreText(0);
    setBestText(best);
    overlay.classList.add("hidden");
    closeManual(true);
    closeSkins(true);
    closeShop(true);
    gameWrap.classList.add("game-wrap--menu");
    menuScreen.classList.remove("hidden");
    blurUi();
  }

  /** Tear down every front-end layer - called when a run begins. */
  function closeFrontEnd() {
    menuView = null;
    menuScreen.classList.add("hidden");
    manual.classList.add("hidden");
    manual.setAttribute("aria-hidden", "true");
    skinsModal.classList.add("hidden");
    skinsModal.setAttribute("aria-hidden", "true");
    shopModal.classList.add("hidden");
    shopModal.setAttribute("aria-hidden", "true");
    gameWrap.classList.remove("game-wrap--menu");
    blurUi();
  }

  function openManual() {
    if (menuView !== "home") return;
    menuView = "instructions";
    manual.classList.remove("hidden");
    manual.setAttribute("aria-hidden", "false");
    drawManualIcons();
    const close = document.getElementById("btn-close-manual");
    if (close) close.focus();
  }

  function closeManual(silent) {
    if (menuView !== "instructions" && !silent) return;
    manual.classList.add("hidden");
    manual.setAttribute("aria-hidden", "true");
    if (silent) return;
    menuView = "home";
    // Hand focus to RUN! so SPACE does the obvious thing next.
    const run = document.getElementById("btn-run");
    if (run) run.focus();
  }

  function openSkins() {
    if (menuView !== "home") return;
    menuView = "skins";
    skinsModal.classList.remove("hidden");
    skinsModal.setAttribute("aria-hidden", "false");
    drawSkinPreviews();
    const close = document.getElementById("btn-close-skins");
    if (close) close.focus();
  }

  function closeSkins(silent) {
    if (menuView !== "skins" && !silent) return;
    skinsModal.classList.add("hidden");
    skinsModal.setAttribute("aria-hidden", "true");
    // Drop the equip pop, or the next open skips that card's entrance stagger.
    for (const entry of skinCards) entry.card.classList.remove("skin-card--pop");
    if (silent) return;
    menuView = "home";
    const skins = document.getElementById("btn-skins");
    if (skins) skins.focus();
  }

  function openShop() {
    if (menuView !== "home") return;
    menuView = "shop";
    shopModal.classList.remove("hidden");
    shopModal.setAttribute("aria-hidden", "false");
    drawShopPreviews();
    const close = document.getElementById("btn-close-shop");
    if (close) close.focus();
  }

  function closeShop(silent) {
    if (menuView !== "shop" && !silent) return;
    shopModal.classList.add("hidden");
    shopModal.setAttribute("aria-hidden", "true");
    // Drop the equip pop, or the next open skips that card's entrance stagger.
    for (const entry of shopCards) entry.card.classList.remove("shop-card--pop");
    if (silent) return;
    menuView = "home";
    const shop = document.getElementById("btn-shop");
    if (shop) shop.focus();
  }

  function bindFrontEnd() {
    document.getElementById("btn-run").addEventListener("click", startGame);
    document.getElementById("btn-run-manual").addEventListener("click", startGame);
    document.getElementById("btn-retry").addEventListener("click", startGame);
    document.getElementById("btn-menu").addEventListener("click", showMenu);
    document.getElementById("btn-instructions").addEventListener("click", openManual);
    document.getElementById("btn-close-manual").addEventListener("click", () => closeManual());
    document.getElementById("btn-skins").addEventListener("click", openSkins);
    document.getElementById("btn-run-skins").addEventListener("click", startGame);
    document.getElementById("btn-close-skins").addEventListener("click", () => closeSkins());
    document.getElementById("btn-shop").addEventListener("click", openShop);
    document.getElementById("btn-run-shop").addEventListener("click", startGame);
    document.getElementById("btn-close-shop").addEventListener("click", () => closeShop());
    document.getElementById("btn-clear-shop").addEventListener("click", () => {
      clearShopLoadout();
      syncShopCards();
      for (const entry of shopCards) entry.card.classList.remove("shop-card--pop");
    });
    // Tap/click the dimmed backdrop (not the card) to dismiss
    manual.addEventListener("pointerdown", (e) => {
      if (e.target === manual) closeManual();
    });
    skinsModal.addEventListener("pointerdown", (e) => {
      if (e.target === skinsModal) closeSkins();
    });
    shopModal.addEventListener("pointerdown", (e) => {
      if (e.target === shopModal) closeShop();
    });

    // The game-over panel promises "tap anywhere" - but #overlay sits above
    // the canvas, so the canvas never sees that tap. Honour it here.
    overlay.addEventListener("pointerdown", (e) => {
      if (state !== State.DEAD) return;
      if (e.target.closest && e.target.closest("button")) return; // buttons stay buttons
      // Touch takes the promise literally; a mouse only gets the backdrop,
      // so a click on the panel's own text can't restart out from under you.
      if (!isTouch && e.target !== overlay) return;
      e.preventDefault();
      startGame();
    });

    // Mid-run restart - the touch stand-in for the R key.
    const restart = document.getElementById("btn-restart-m");
    if (restart) restart.addEventListener("click", startGame);
  }

  // ── Main loop ─────────────────────────────────────────────────
  function frame(now) {
    const dt = Math.min(0.033, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    // dt is already clamped, so a frozen sim needs no catch-up on resume -
    // simply don't advance it. Drawing continues so the world stays correct
    // behind the resume gate.
    if (!portraitLocked && !awaitingResume) update(dt);
    draw();
    if (menuView === "instructions") drawManualIcons();
    else if (menuView === "skins") drawSkinPreviews();
    else if (menuView === "shop") drawShopPreviews();
    requestAnimationFrame(frame);
  }

  // Boot
  initResponsive();
  resetWorld();
  initSnow();
  // Place player on first platform for menu idle
  player.y = GROUND_Y - PLAYER_SIZE;
  buildManual();
  buildSkins();
  buildShop();
  bindFrontEnd();
  setBestText(best);
  gameWrap.classList.add("game-wrap--menu");
  requestAnimationFrame(frame);
})();
