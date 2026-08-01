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
  /** Backing-store scale — re-applied every frame in draw(). */
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
   * so the ramp stays — it just tops out early: 280 → 400 over the first 20s,
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
  /** Derived from W — recomputed by layout(), never read before it runs. */
  let SPAWN_AHEAD = W + 200;

  // Milestone tuning
  const SIGN_INTERVAL = 100; // points between ice signs
  const THEME_INTERVAL = 1000;
  const SCORE_TO_DIST = 10; // score = distance * 0.1

  // ══════════════════════════════════════════════════════════════
  // ENEMY SYSTEM (scalable)
  // ──────────────────────────────────────────────────────────────
  // HOW TO ADD A NEW ENEMY (for future agents):
  //   1. Add an id to EnemyKind below.
  //   2. Register a full entry in ENEMY_TYPES (unlockScore, spawnWeight,
  //      canShoot, dropPowerup, lethalOnContact, draw style keys…), plus the
  //      manual fields: name + desc (shown in the Instructions screen, which
  //      is generated straight from this table — no second list to update).
  //   3. If it needs unique art, extend drawEnemyInstance() with a branch
  //      on e.type (see "dropper" / "gunner" for patterns).
  //   4. Optional behavior hooks: onStomp via dropPowerup / custom flags;
  //      shooting via canShoot + updateEnemyBehavior().
  //   5. Spawning is automatic once unlockScore is met (weighted pick).
  //
  // Current roster:
  //   raider  — regular red angry square. Unlocks at 100 pts.
  //   dropper — yellow "?" powerup carrier. Unlocks at 300 pts. Stomp = powerup.
  //   gunner  — armed red raider with blaster. Unlocks at 1000 pts.
  //   flyer   — purple winged raider, ignores gravity. Unlocks at 2000 pts.
  //   spiker  — blue raider, spikes out 1s / in 1s. Unlocks at 3000 pts.
  //   brute   — black 2×2 hulk with glowing eyes. Unlocks at 4000 pts.
  //   frost   — white raider, spikes never retract. Unlocks at 5000 pts.
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
      desc: "Charges straight down the lane. <strong>Stomp it from above</strong> to squash it — any side bump is fatal. Hit <strong>{{JUMP}}</strong> as you land for a double-height boost jump.",
    },
    [EnemyKind.DROPPER]: {
      id: EnemyKind.DROPPER,
      unlockScore: 0,
      spawnWeight: 0.4,
      lethalOnContact: true,
      canShoot: false,
      dropPowerup: "random", // stomp grants a random id from POWERUP_DROP_IDS
      fxColor: "rgba(255, 210, 60,",
      hitReason: "You ran into a powerup dropper! Stomp the yellow ? boxes from above.",
      label: "powerup dropper",
      name: "Powerup Dropper",
      desc: "A yellow <strong>?</strong> box. Stomp it and it hands over a <strong>random powerup</strong> — but run into its side and it kills you like any raider.",
    },
    [EnemyKind.GUNNER]: {
      id: EnemyKind.GUNNER,
      unlockScore: 1000,
      spawnWeight: 0.35,
      lethalOnContact: true,
      canShoot: true,
      dropPowerup: null,
      fxColor: "rgba(255, 80, 70,",
      hitReason: "An armed ice raider got you! Stomp them from above — don't run into them.",
      label: "armed raider",
      name: "Gunner",
      desc: "An armed raider that <strong>fires glowing bolts</strong> down the ice. Jump the shots, then land on its head — or shoot back if you're carrying the gun.",
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
      hitReason: "A winged raider clipped you! They cruise over the gaps — stomp them out of the air.",
      label: "winged raider",
      name: "Winged Raider",
      desc: "Purple and airborne. It <strong>glides over gaps</strong> instead of falling in, so it comes at you where there is no ice to stand on. Still squashes if you land on its head.",
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
      hitReason: "The blue spiker got you! Watch its head — stomp only while the spikes are tucked in.",
      label: "spiker",
      name: "Blue Spiker",
      desc: "Head spikes that pop <strong>out for 1s, in for 1s</strong>. Land on it while they're <strong>out</strong> and you're done — time your stomp for the second they retract.",
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
      hitReason: "The black brute flattened you! It's twice the size — go over the top, never around.",
      label: "brute",
      name: "Black Brute",
      desc: "A slab of black ice <strong>twice as wide and twice as tall</strong> as a raider, with glowing red eyes. Too big to jump clean — land on its head instead.",
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
      hitReason: "The white spiker got you! Its spikes never retract — you cannot stomp that one.",
      label: "white spiker",
      name: "White Spiker",
      desc: "Bone-white, with spikes that <strong>never retract</strong>. There is <strong>no stomping this one</strong> — jump it clean or shoot it with the gun.",
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
      tag: "always",
      desc: "Missing ice. Time your <strong>{{JUMP}}</strong> or you slide straight into the abyss.",
    },
    {
      icon: "spike",
      name: "Ice Spikes",
      tag: "always",
      desc: "Frozen shards planted in the slab. There is <strong>no stomping these</strong> — jump them clean.",
    },
    {
      icon: "crate",
      name: "Ice Crate",
      tag: "always",
      desc: "A solid block parked on the track. <strong>Stomp it from above</strong> to shatter it — clip it from the side and the run is over.",
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
  //        duration   — seconds active (0 = until consumed / permanent flag)
  //        warnAt     — start blinking when remaining ≤ this many seconds
  //        absorbHit  — if true, one lethal contact is blocked and the
  //                     powerup is removed (see tryAbsorbHit)
  //        exclusive  — if true, granting replaces any other exclusive buffs
  //        onGrant / onExpire / onUpdate — optional lifecycle hooks
  //        draw(ctx, player, state) — optional overlay while active
  //        name / desc — copy for the Instructions screen, which is built
  //                     straight from this table (its icon is the player
  //                     sprite wearing the powerup, so no extra art needed)
  //   3. Add the id to POWERUP_DROP_IDS so droppers can grant it (equal weight).
  //   4. Grant with grantPowerup("id"). Runtime state lives in activePowerups.
  //   5. Lethal contacts should call playerTakeHit(reason) so absorbHit works.
  //
  // Current powerups:
  //   shield — bubble, 10s, pops on first hit, blinks in last 2s.
  //   wings  — held until used; SPACE in air = one extra jump, then wings pop.
  //   gun    — 10s, auto-shoots on-screen enemies ahead, blinks in last 2s.
  //   bridge — held until used; next gap fall deploys a bridge under the player.
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
      desc: "A bubble for <strong>10s</strong> that eats <strong>one lethal hit</strong>, then pops. It blinks for the last 2 seconds — that's your cue.",
    },
    wings: {
      id: "wings",
      duration: 0, // until used (double-jump)
      warnAt: 0,
      absorbHit: false,
      exclusive: false,
      label: "Wings",
      name: "Wings",
      desc: "Kept until you spend them. Use <strong>{{JUMP}} in mid-air</strong> for one extra jump — then the wings burst into feathers.",
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
  /** Set by the 1–5 warp shortcut — such a run never writes the saved best. */
  let warped = false;
  let runTime = 0;
  let speed = BASE_SPEED;
  let distance = 0;
  let shake = 0;
  let particles = [];
  let snowflakes = [];
  let fireworks = [];

  /** Milestone signs every 100 pts — on ice, or floating in a bubble over a gap */
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

  let themeIndex = 0;
  let themeBlend = 1; // 0..1 blend into current theme
  let lastThemeTier = 0;
  let fireworksQueue = 0;

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
  // One source of truth for "what kind of device is this" — JS owns the
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
    // when something actually changed — and re-apply the transform in draw().
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
    // The world was generated for the old width — top it up for the new one.
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

  /** A focused UI button owns SPACE / ENTER — don't also fire the game action. */
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

  function onJumpDown(e) {
    if (e.type === "keydown" && e.code !== "Space" && e.key !== " ") return;
    if (menuView === "instructions" || keyOwnedByUi(e)) return;
    if (e.type === "keydown" && (e.code === "Space" || e.key === " ")) {
      e.preventDefault();
    }
    if (portraitLocked) return;
    // A paused run consumes the input that wakes it — no accidental jump.
    if (awaitingResume) {
      resumeRun();
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

  /** Hidden test shortcut — keyboard only, deliberately absent from the manual. */
  const WARP_KEYS = {
    Digit1: 1000,
    Digit2: 2000,
    Digit3: 3000,
    Digit4: 4000,
    Digit5: 5000,
  };

  function onKeyDown(e) {
    if (e.code === "Escape") {
      if (menuView === "instructions") {
        e.preventDefault();
        closeManual();
      }
      return;
    }
    if (menuView === "instructions") return; // manual is modal — keys pass through to it
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
    const start = fromX + Math.max(MIN_GAP, gap);
    const width = Math.max(140, platW);

    platforms.push({
      x: start,
      w: width,
      y: GROUND_Y,
      h: H - GROUND_Y,
    });

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

  function ensureWorld() {
    // Drop platforms / obstacles that scrolled far left
    platforms = platforms.filter((p) => p.x + p.w > -100);
    obstacles = obstacles.filter((o) => o.x + o.w > -100);
    signs = signs.filter((s) => s.x > distance - 200);

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
    // Gap (or edge) — bubble float at the milestone world X
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
    return 0; // tucked in — safe to stomp
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
  function pickEnemyType() {
    const unlocked = Object.values(ENEMY_TYPES).filter((t) => score >= t.unlockScore);
    if (!unlocked.length) return null;
    let total = 0;
    for (const t of unlocked) total += t.spawnWeight;
    let r = Math.random() * total;
    for (const t of unlocked) {
      r -= t.spawnWeight;
      if (r <= 0) return t.id;
    }
    return unlocked[unlocked.length - 1].id;
  }

  function spawnEnemy() {
    const typeId = pickEnemyType();
    if (!typeId) return;
    const def = getEnemyDef(typeId);

    // Spawn ahead of the player (off-screen right), approach from opposite direction
    const worldX = distance + W + rand(40, 160);
    const size = enemySizeOf(typeId);

    // Flyers cruise at altitude and never touch the ice; the rest prefer a slab
    let y;
    if (def.flying) {
      y = GROUND_Y - size - rand(FLY_HOVER_MIN, FLY_HOVER_MAX);
    } else {
      y = GROUND_Y - size;
      for (const p of platforms) {
        if (p.y < GROUND_Y - 1) continue;
        if (worldX >= p.x + 10 && worldX <= p.x + p.w - size - 10) {
          y = p.y - size;
          break;
        }
      }
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
    });
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

  /** Shatter a crate under the player's feet. Mirrors stompEnemy's FX. */
  function smashCrate(index, screenX) {
    const o = obstacles[index];
    if (!o) return;
    const cx = screenX + o.w / 2;
    const cy = o.y + o.h * 0.55;

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
        color: Math.random() < 0.5 ? "rgba(184, 216, 240," : "rgba(74, 122, 152,",
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

      // Move opposite to player travel (leftward in world space)
      e.x -= approach * dt;
      e.bob += dt * 6;
      if (def.spikes === "toggle") e.spikeT += dt;

      if (def.flying) {
        // No gravity and no platform test — flyers cruise straight over gaps.
        e.y = e.baseY + Math.sin(e.bob * 0.5) * FLY_BOB;
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

  /** Activate or refresh a powerup by id (see POWERUP_DEFS). */
  function grantPowerup(id) {
    const def = POWERUP_DEFS[id];
    if (!def) return;

    if (def.exclusive) {
      for (const [otherId, other] of activePowerups) {
        if (other.def.exclusive && otherId !== id) {
          expirePowerup(otherId, false);
        }
      }
    }

    const existing = activePowerups.get(id);
    if (existing) {
      // Refresh timer on re-collect
      existing.remaining = def.duration;
      if (id === "gun") existing.fireCd = 0;
    } else {
      activePowerups.set(id, {
        id,
        remaining: def.duration,
        def,
        fireCd: id === "gun" ? 0.05 : 0,
      });
    }

    if (typeof def.onGrant === "function") def.onGrant();

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

  /** Friendly (player gun) bullets destroy enemies on contact — no stomp rewards. */
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
   */
  function playerTakeHit(reason) {
    if (hitInvuln > 0) return false;
    if (tryAbsorbHit()) return false;
    die(reason);
    return true;
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
  /** Put the square back on its feet — used by both the run and the idle menu. */
  /** Score and best each render twice — page HUD and in-canvas HUD. */
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
    warped = false;
    state = State.PLAYING;
    awaitingResume = false;
    releaseJump();
    closeFrontEnd();
    overlay.classList.add("hidden");
    setScoreText(0);
    setRunning(true);
    syncResumeGate();
  }

  /**
   * Inverse of the speed ramp: the run time that would have covered `d`.
   * distance = BASE_SPEED·t + SPEED_RAMP·t²/2 until the speed caps, then it
   * goes linear. Keeps a warped run scrolling as fast as an honest one — the
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
   * forward, so bumping `distance` alone would generate — and then keep
   * iterating — hundreds of dead platforms behind the player.
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

    // A warped run is a test run — it never overwrites the saved best.
    if (!warped && score > best) {
      best = score;
      localStorage.setItem("iceSlideBest", String(Math.floor(best)));
      setBestText(best);
    }

    overlayTitle.textContent = "You fell!";
    overlayMsg.innerHTML =
      `${reason}<br><br>Score: <strong style="color:#5ec8ff">${Math.floor(score)}</strong>` +
      (!warped && score >= best && score > 0 ? " — new best!" : "");
    gameWrap.classList.add("game-wrap--menu");
    overlay.classList.remove("hidden");
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
      }
      return;
    }

    runTime += dt;
    speed = Math.min(MAX_SPEED, BASE_SPEED + runTime * SPEED_RAMP);
    distance += speed * dt;
    score = distance * 0.1;
    setScoreText(score);

    updateThemeAndMilestones();
    ensureWorld();
    updateEnemies(dt);
    updateBullets(dt);
    updatePowerups(dt); // gun may spawn friendly bullets this frame
    resolveFriendlyBullets();
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
            // Absorbed — clear the enemy so the spikes can't chain-kill
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

    // Crates squash like enemies — same window, same bounce. Spikes never do.
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
          smashCrate(i, ox);
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
          smashCrate(oi, ox);
          applyStompBounce(top);
          stompedThisFrame = true;
          continue;
        }
        if (playerTakeHit("You hit an ice hazard. Watch the spikes and crates!")) return;
        // Absorbed: nudge past this obstacle so we don't re-hit same frame
        // (obstacle still solid; brief invuln via powerup removal is enough)
      }
    }

    // Side / body hit only — stomping from above already handled
    for (let ei = enemies.length - 1; ei >= 0; ei--) {
      const e = enemies[ei];
      const ex = e.x - distance;
      if (!rectsOverlap(px, player.y, pw, ph, ex, e.y, e.w, e.h)) continue;

      const def = getEnemyDef(e);

      // Safety: if we're still clearly on top while falling, treat as stomp —
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
        // Shield absorbed — knock enemy away so contact doesn't chain-kill
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
    drawPlayer();
    drawPowerupOverlays();
    drawParticles();
    drawSnow();
    drawGroundGlow();

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

    // Distant mountains — the ridge tiles so it fills any W, and so the
    // parallax offset can't slide a bare patch of sky in from the right.
    ctx.fillStyle = theme.mountain;
    const drift = (-distance * 0.05) % 200; // -200..0
    for (let tile = 0; tile * MOUNTAIN_PERIOD - 240 <= W + 40; tile++) {
      const off = tile * MOUNTAIN_PERIOD + drift;
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

    // Abyss under gaps — subtle void
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
   * hitbox — enemySpikesOut() alone decides whether a stomp lands.
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

  /** Purple winged raider — flies over gaps, still stompable. */
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

  /** Blue spiker — head spikes cycle out (1s) and in (1s). */
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

  /** White spiker — same spikes, permanently out. Never stompable. */
  function drawEnemyFrost(e) {
    drawRaiderShell(e, ["#ffffff", "#dfe9f5", "#9aa9bd"], "#2b3a4d", "#7fd8ff");
    drawHeadSpikes(e, 1, "#ffffff", "rgba(90, 110, 140, 0.9)");
  }

  /** Black brute — 2×2 raider with shining red eyes. */
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

  /** Yellow powerup dropper with a "?" mark — stomp to grant a powerup. */
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

  function drawPlayer() {
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const sx = player.squish;
    const sy = 2 - player.squish;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(player.rotation);
    ctx.scale(sx, sy);

    // Soft shadow
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    ctx.beginPath();
    ctx.ellipse(0, player.h / 2 + 4, player.w * 0.45, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    const body = ctx.createLinearGradient(
      -player.w / 2,
      -player.h / 2,
      player.w / 2,
      player.h / 2
    );
    if (player.dead) {
      body.addColorStop(0, "#ff8a9a");
      body.addColorStop(1, "#c04050");
    } else {
      body.addColorStop(0, "#7aefc0");
      body.addColorStop(0.5, "#3dd68c");
      body.addColorStop(1, "#1faa68");
    }
    roundRect(-player.w / 2, -player.h / 2, player.w, player.h, 6);
    ctx.fillStyle = body;
    ctx.fill();

    // Shine
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    roundRect(-player.w / 2 + 4, -player.h / 2 + 4, player.w * 0.45, 8, 3);
    ctx.fill();

    // Eyes
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

    ctx.restore();

    // Motion trail when fast
    if (state === State.PLAYING && speed > 320 && player.onGround) {
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = "#3dd68c";
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
  // FRONT END — entrance screen & field manual
  // ──────────────────────────────────────────────────────────────
  // The entrance screen is a DOM layer over the canvas, so the live idle
  // world (sky, aurora, mountains, snow, bobbing square) keeps running as
  // its backdrop. The manual is a modal, and every row's icon is painted
  // by the *game's own* draw functions onto a tiny canvas — so the art in
  // the instructions can never drift from the art in the run.
  // ══════════════════════════════════════════════════════════════
  const ICON_SIZE = 62; // CSS px — matches .entry-icon in style.css

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
    // Every type is drawn at ENEMY_SIZE here — the 68px brute wouldn't fit the
    // 62px tile, so its scale is described in the copy instead of the art.
    const e = {
      w: ENEMY_SIZE,
      h: ENEMY_SIZE,
      type: kind,
      bob: t / 400,
      // Icons animate their spike cycle just like the live enemy
      spikeT: (t / 1000) % SPIKE_CYCLE,
    };
    // Gunners carry a blaster off their left side — nudge right to keep it in frame
    const cx = S / 2 + (kind === EnemyKind.GUNNER ? 6 : 0);
    // Wings reach past the body (pull in); the brute reads as a slab (push out)
    const scale =
      kind === EnemyKind.FLYER ? 0.68 : kind === EnemyKind.BRUTE ? 1.35 : 1;

    ctx.save();
    ctx.translate(cx, S / 2 + bob + (kind === EnemyKind.SPIKER || kind === EnemyKind.FROST ? 5 : 0));
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

    drawPlayer();
    // Timed powerups blink near expiry — Infinity keeps the icon solid.
    const fake = { id, remaining: Infinity, def };
    if (id === "shield") drawShieldBubble(fake);
    else if (id === "wings") drawWingsOverlay(fake);
    else if (id === "gun") drawGunOverlay(fake);
    else if (id === "bridge") drawBridgeOverlay(fake);

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
    // The death jolt keeps rattling through the game-over screen on purpose —
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
    gameWrap.classList.add("game-wrap--menu");
    menuScreen.classList.remove("hidden");
    blurUi();
  }

  /** Tear down every front-end layer — called when a run begins. */
  function closeFrontEnd() {
    menuView = null;
    menuScreen.classList.add("hidden");
    manual.classList.add("hidden");
    manual.setAttribute("aria-hidden", "true");
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

  function bindFrontEnd() {
    document.getElementById("btn-run").addEventListener("click", startGame);
    document.getElementById("btn-run-manual").addEventListener("click", startGame);
    document.getElementById("btn-retry").addEventListener("click", startGame);
    document.getElementById("btn-menu").addEventListener("click", showMenu);
    document.getElementById("btn-instructions").addEventListener("click", openManual);
    document.getElementById("btn-close-manual").addEventListener("click", () => closeManual());
    // Tap/click the dimmed backdrop (not the card) to dismiss
    manual.addEventListener("pointerdown", (e) => {
      if (e.target === manual) closeManual();
    });

    // The game-over panel promises "tap anywhere" — but #overlay sits above
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

    // Mid-run restart — the touch stand-in for the R key.
    const restart = document.getElementById("btn-restart-m");
    if (restart) restart.addEventListener("click", startGame);
  }

  // ── Main loop ─────────────────────────────────────────────────
  function frame(now) {
    const dt = Math.min(0.033, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    // dt is already clamped, so a frozen sim needs no catch-up on resume —
    // simply don't advance it. Drawing continues so the world stays correct
    // behind the resume gate.
    if (!portraitLocked && !awaitingResume) update(dt);
    draw();
    if (menuView === "instructions") drawManualIcons();
    requestAnimationFrame(frame);
  }

  // Boot
  initResponsive();
  resetWorld();
  initSnow();
  // Place player on first platform for menu idle
  player.y = GROUND_Y - PLAYER_SIZE;
  buildManual();
  bindFrontEnd();
  setBestText(best);
  gameWrap.classList.add("game-wrap--menu");
  requestAnimationFrame(frame);
})();
