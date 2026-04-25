(function () {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const elScore = document.getElementById("score");
  const elHigh = document.getElementById("highScore");
  const elLevel = document.getElementById("level");
  const elLives = document.getElementById("lives");
  const elBuffs = document.getElementById("buffsLine");
  const elStatus = document.getElementById("statusLine");

  const W = canvas.width;
  const H = canvas.height;

  const ROWS = 5;
  const COLS = 11;
  const ALIEN_W = 11;
  const ALIEN_H = 8;
  const ALIEN_GAP_X = 6;
  const ALIEN_GAP_Y = 8;

  /** Points per row index r=0 (top) … r=4 (bottom, closest to player). */
  const ROW_POINTS = [10, 10, 20, 20, 30];

  const PLAYER_W = 16;
  const PLAYER_H = 10;
  const PLAYER_SPEED = 85;
  const PLAYER_Y = H - 28;
  const BULLET_SPEED = 200;
  const BASE_FIRE_COOLDOWN = 0.35;
  const BOMB_SPEED = 70;
  const LEVEL_SCORE_BASE_STEP = 500;
  const LEVEL_SCORE_STEP_GROWTH = 200;
  const TEMP_BUFF_DURATION = 15;
  /** Vertical drop when formation hits screen edge (smaller = slower descent). */
  const FORMATION_DROP = 10;

  /** @type {'title'|'playing'|'wave_clear'|'upgrade_select'|'gameover'|'win'} */
  let phase = "title";
  let score = 0;
  let highScore = Number(localStorage.getItem("si-high") || 0) || 0;
  let lives = 3;
  let wave = 1;
  let level = 1;
  let nextLevelScore = LEVEL_SCORE_BASE_STEP;
  function levelStepFor(levelValue) {
    return LEVEL_SCORE_BASE_STEP + (levelValue - 1) * LEVEL_SCORE_STEP_GROWTH;
  }

  let pendingLevelUps = 0;
  let gameTime = 0;

  const upgrades = [
    { id: "extra_life", label: "+1 LIFE", description: "Gain one extra life." },
    {
      id: "double_shot",
      label: "DOUBLE SHOT",
      description: "Ship fires two bullets at once.",
    },
    {
      id: "rapid_fire",
      label: "RAPID FIRE",
      description: "Higher fire rate (stackable).",
    },
    {
      id: "shield",
      label: "TEMP SHIELD",
      description: "Ignore enemy bombs for 15 seconds.",
    },
    {
      id: "score_boost",
      label: "2X SCORE",
      description: "Double points for 15 seconds.",
    },
  ];

  let hasDoubleShot = false;
  let fireRateMultiplier = 1;
  let shieldUntil = 0;
  let scoreBoostUntil = 0;
  let fireCooldown = 0;
  let offeredUpgrades = [];
  let upgradeCursor = 0;
  let levelBanner = null;

  /** @type {{keys: Record<string,boolean>, edge: Record<string,boolean>}} */
  const input = { keys: {}, edge: {} };

  let formationX = 40;
  let formationY = 56;
  let alienDir = 1;
  /** @type {number[][]} */
  let aliens = [];

  let alienMoveAcc = 0;
  /** Seconds between formation steps; decreases as fewer aliens remain. */
  let alienMovePeriod = 0.55;
  /** Pending next wave after clear (cleared on quit to title). */
  let waveClearTimeoutId = null;
  let alienBombAcc = 0;
  let mysteryAcc = 0;
  let mysteryShip = null;

  let playerX = W / 2 - PLAYER_W / 2;

  /** @type {{ x: number, y: number, vx: number }[]} */
  let playerBullets = [];

  /** @type {{ x: number, y: number }[]} */
  let bombs = [];

  /** @type {{ ox: number, cells: Uint8Array, cw: number, ch: number, bw: number, bh: number }[]} */
  let bunkers = [];

  let muted = false;
  let audioCtx = null;

  function beep(freq, dur, type = "square", vol = 0.06) {
    if (muted) return;
    try {
      if (!audioCtx)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") void audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = vol;
      o.connect(g);
      g.connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      o.start(t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.stop(t + dur);
    } catch (_) {}
  }

  function pulseMoveSound() {
    const n = countAliens();
    const base = 80 + (55 - n) * 2;
    beep(base, 0.04, "square", 0.05);
  }

  function initAliens() {
    const rowHealth = buildRowHealthForLevel(level);
    aliens = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(rowHealth[r]);
      aliens.push(row);
    }
    formationX = 24;
    formationY = 48 + Math.min(18, (wave - 1) * 10);
    alienDir = 1;
    alienMoveAcc = 0;
    alienBombAcc = 0;
    mysteryAcc = 0;
    mysteryShip = null;
    syncAlienSpeed();
  }

  function shuffledRowIndices() {
    const rows = [];
    for (let r = 0; r < ROWS; r++) rows.push(r);
    for (let i = rows.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = rows[i];
      rows[i] = rows[j];
      rows[j] = tmp;
    }
    return rows;
  }

  function buildRowHealthForLevel(levelValue) {
    const health = new Array(ROWS).fill(1);
    if (levelValue <= 1) return health;

    // Level 2 -> two random tougher rows, level 3 -> three, etc.
    // Above ROWS, extra "tier points" keep stacking into higher HP.
    const extraTierPoints = levelValue;
    const fullTierBoost = Math.floor(extraTierPoints / ROWS);
    const partialBoostRows = extraTierPoints % ROWS;
    const shuffledRows = shuffledRowIndices();

    for (let r = 0; r < ROWS; r++) health[r] += fullTierBoost;
    for (let i = 0; i < partialBoostRows; i++) {
      health[shuffledRows[i]] += 1;
    }
    return health;
  }

  function initBunkers() {
    bunkers = [];
    const cw = 3;
    const ch = 3;
    const bw = 22;
    const bh = 16;
    const tops = [
      Math.floor(W * 0.13),
      Math.floor(W * 0.31),
      Math.floor(W * 0.53),
      Math.floor(W * 0.71),
    ];
    const oy = PLAYER_Y - 54;
    for (let i = 0; i < 4; i++) {
      const ox = tops[i];
      const cells = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          let v = 0;
          if (y < 8) {
            if (x >= 1 && x < bw - 1) v = 1;
          } else if (y < 12) {
            const holeL = 7;
            const holeR = bw - 7;
            if (x >= 1 && x < holeL) v = 1;
            if (x >= holeR && x < bw - 1) v = 1;
          } else {
            if ((x >= 1 && x < 6) || (x >= bw - 6 && x < bw - 1)) v = 1;
          }
          cells[y * bw + x] = v;
        }
      }
      bunkers.push({ ox, oy, cells, cw, ch, bw, bh });
    }
  }

  function syncAlienSpeed() {
    const alive = countAliens();
    const factor = alive > 0 ? 55 / alive : 1;
    /** Base pause between steps; wave 1 uses a gentler curve. */
    const base = wave <= 1 ? 0.78 : wave === 2 ? 0.68 : 0.62;
    alienMovePeriod = Math.max(0.036, base / factor);
  }

  function countAliens() {
    let n = 0;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (aliens[r][c] > 0) n++;
    return n;
  }

  function formationBounds() {
    let minC = COLS,
      maxC = -1,
      minR = ROWS,
      maxR = -1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (aliens[r][c] <= 0) continue;
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
      }
    }
    if (maxC < 0) return null;
    const left = formationX + minC * (ALIEN_W + ALIEN_GAP_X);
    const right =
      formationX +
      maxC * (ALIEN_W + ALIEN_GAP_X) +
      ALIEN_W;
    const bottom =
      formationY +
      maxR * (ALIEN_H + ALIEN_GAP_Y) +
      ALIEN_H;
    return { left, right, bottom };
  }

  function alienWorldRect(r, c) {
    const x = formationX + c * (ALIEN_W + ALIEN_GAP_X);
    const y = formationY + r * (ALIEN_H + ALIEN_GAP_Y);
    return { x, y, w: ALIEN_W, h: ALIEN_H };
  }

  function triggerLevelBanner(title, subtitle) {
    levelBanner = {
      title,
      subtitle,
      elapsed: 0,
      duration: 1.6,
    };
  }

  function isShieldActive() {
    return shieldUntil > gameTime;
  }

  function isScoreBoostActive() {
    return scoreBoostUntil > gameTime;
  }

  function addScore(points) {
    const mult = isScoreBoostActive() ? 2 : 1;
    score += points * mult;
    while (score >= nextLevelScore) {
      level += 1;
      pendingLevelUps += 1;
      nextLevelScore += levelStepFor(level);
    }
    if (phase === "playing" && pendingLevelUps > 0) {
      beginUpgradeSelection();
    }
  }

  function pickUpgradeOffers(count) {
    const pool = upgrades.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, Math.min(count, pool.length));
  }

  function applyUpgrade(upgradeId) {
    switch (upgradeId) {
      case "extra_life":
        lives += 1;
        renderLives();
        beep(700, 0.08, "triangle", 0.06);
        break;
      case "double_shot":
        hasDoubleShot = true;
        beep(620, 0.08, "square", 0.06);
        break;
      case "rapid_fire":
        fireRateMultiplier = Math.min(2.3, fireRateMultiplier + 0.35);
        beep(760, 0.08, "square", 0.06);
        break;
      case "shield":
        shieldUntil = Math.max(shieldUntil, gameTime + TEMP_BUFF_DURATION);
        beep(430, 0.09, "triangle", 0.06);
        break;
      case "score_boost":
        scoreBoostUntil = Math.max(
          scoreBoostUntil,
          gameTime + TEMP_BUFF_DURATION
        );
        beep(560, 0.09, "triangle", 0.06);
        break;
      default:
        break;
    }
  }

  function beginUpgradeSelection() {
    if (pendingLevelUps <= 0 || phase !== "playing") return;
    pendingLevelUps -= 1;
    offeredUpgrades = pickUpgradeOffers(3);
    upgradeCursor = 0;
    phase = "upgrade_select";
    elStatus.textContent = `Level ${level} reached! Choose an upgrade`;
    triggerLevelBanner(`LEVEL ${level}`, "UPGRADE READY");
  }

  function chooseUpgrade(index) {
    if (phase !== "upgrade_select" || !offeredUpgrades.length) return;
    const safeIndex = Math.max(0, Math.min(index, offeredUpgrades.length - 1));
    const selected = offeredUpgrades[safeIndex];
    applyUpgrade(selected.id);
    triggerLevelBanner(`LEVEL ${level}`, selected.label);
    offeredUpgrades = [];
    phase = "playing";
    elStatus.textContent = `Wave ${wave}`;
    if (pendingLevelUps > 0) beginUpgradeSelection();
  }

  function tryShootPlayer() {
    if (fireCooldown > 0) return;
    const centerX = playerX + PLAYER_W / 2 - 1;
    if (hasDoubleShot) {
      playerBullets.push({ x: centerX - 4, y: PLAYER_Y - 4, vx: -14 });
      playerBullets.push({ x: centerX + 4, y: PLAYER_Y - 4, vx: 14 });
    } else {
      playerBullets.push({ x: centerX, y: PLAYER_Y - 4, vx: 0 });
    }
    fireCooldown = BASE_FIRE_COOLDOWN / fireRateMultiplier;
    beep(520, 0.06, "square", 0.05);
  }

  function maybeAlienBomb(dt) {
    if (countAliens() === 0) return;
    alienBombAcc += dt;
    const interval = Math.max(0.35, 1.2 - wave * 0.08);
    if (alienBombAcc < interval) return;
    alienBombAcc = 0;

    const candidates = [];
    for (let c = 0; c < COLS; c++) {
      let rBottom = -1;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (aliens[r][c]) {
          rBottom = r;
          break;
        }
      }
      if (rBottom >= 0) candidates.push({ r: rBottom, c });
    }
    if (!candidates.length) return;
    const pick = candidates[(Math.random() * candidates.length) | 0];
    const ar = alienWorldRect(pick.r, pick.c);
    bombs.push({
      x: ar.x + ALIEN_W / 2 - 1,
      y: ar.y + ALIEN_H,
    });
  }

  function maybeMystery(dt) {
    if (mysteryShip || countAliens() === 0) return;
    mysteryAcc += dt;
    if (mysteryAcc < 12 + Math.random() * 8) return;
    mysteryAcc = 0;
    const left = Math.random() < 0.5;
    mysteryShip = {
      x: left ? -20 : W + 20,
      vx: left ? 45 : -45,
    };
    beep(180, 0.08, "triangle", 0.04);
  }

  function updateMystery(dt) {
    if (!mysteryShip) return;
    mysteryShip.x += mysteryShip.vx * dt;
    if (mysteryShip.x < -40 || mysteryShip.x > W + 40) mysteryShip = null;
  }

  function collideRect(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  function damageBunkerAtWorld(bunker, wx, wy) {
    const { ox, oy, cells, cw, ch, bw, bh } = bunker;
    const bwPx = bw * cw;
    const bhPx = bh * ch;
    if (wx < ox || wx >= ox + bwPx || wy < oy || wy >= oy + bhPx) return false;
    const cx0 = Math.floor((wx - ox) / cw);
    const cy0 = Math.floor((wy - oy) / ch);
    let any = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = cx0 + dx;
        const cy = cy0 + dy;
        if (cx < 0 || cx >= bw || cy < 0 || cy >= bh) continue;
        const i = cy * bw + cx;
        if (cells[i]) {
          cells[i] = 0;
          any = true;
        }
      }
    }
    return any;
  }

  function update(dt) {
    const edge = input.edge;
    input.edge = {};

    if (phase === "title") {
      if (input.keys["Enter"]) startGame();
      return;
    }
    if (phase === "gameover" || phase === "win") {
      if (input.keys["Enter"] || input.keys["KeyR"]) resetToTitle();
      return;
    }
    if (levelBanner) {
      levelBanner.elapsed += dt;
      if (levelBanner.elapsed >= levelBanner.duration) levelBanner = null;
    }
    if (phase === "wave_clear") {
      return;
    }
    if (phase === "upgrade_select") {
      if (!offeredUpgrades.length) {
        phase = "playing";
        return;
      }
      if (edge["ArrowLeft"] || edge["KeyA"]) {
        upgradeCursor =
          (upgradeCursor - 1 + offeredUpgrades.length) % offeredUpgrades.length;
      }
      if (edge["ArrowRight"] || edge["KeyD"]) {
        upgradeCursor = (upgradeCursor + 1) % offeredUpgrades.length;
      }
      if (edge["Digit1"]) chooseUpgrade(0);
      else if (edge["Digit2"]) chooseUpgrade(1);
      else if (edge["Digit3"]) chooseUpgrade(2);
      else if (edge["Enter"] || edge["Space"]) chooseUpgrade(upgradeCursor);
      return;
    }

    if (phase !== "playing") return;
    gameTime += dt;
    fireCooldown = Math.max(0, fireCooldown - dt);

    if (input.keys["ArrowLeft"]) playerX -= PLAYER_SPEED * dt;
    if (input.keys["ArrowRight"]) playerX += PLAYER_SPEED * dt;
    playerX = Math.max(8, Math.min(W - PLAYER_W - 8, playerX));

    if (input.keys["Space"]) tryShootPlayer();

    const bounds = formationBounds();
    if (bounds && bounds.bottom >= PLAYER_Y - 4) {
      endGame(false);
      return;
    }

    alienMoveAcc += dt;
    /** Pixels per horizontal invader step (lower = slower lateral creep). */
    const FORM_STEP = 3;
    const margin = 10;
    while (alienMoveAcc >= alienMovePeriod) {
      alienMoveAcc -= alienMovePeriod;
      const b = formationBounds();
      if (!b) {
        alienMoveAcc = 0;
        break;
      }
      const nextLeft = b.left + alienDir * FORM_STEP;
      const nextRight = b.right + alienDir * FORM_STEP;
      if (nextLeft < margin || nextRight > W - margin) {
        alienDir *= -1;
        formationY += FORMATION_DROP;
        pulseMoveSound();
        break;
      }
      formationX += alienDir * FORM_STEP;
      pulseMoveSound();
    }

    maybeAlienBomb(dt);
    maybeMystery(dt);
    updateMystery(dt);

    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const bullet = playerBullets[i];
      bullet.y -= BULLET_SPEED * dt;
      bullet.x += bullet.vx * dt;
      const bulletRect = {
        x: bullet.x,
        y: bullet.y,
        w: 2,
        h: 8,
      };

      let hit = false;

      if (mysteryShip) {
        const mr = {
          x: mysteryShip.x,
          y: 36,
          w: 24,
          h: 10,
        };
        if (collideRect(bulletRect, mr)) {
          const bonus = [50, 100, 150, 300][(Math.random() * 4) | 0];
          addScore(bonus);
          mysteryShip = null;
          mysteryAcc = 0;
          hit = true;
          beep(240, 0.12, "triangle", 0.07);
        }
      }

      if (!hit) {
        outer: for (let r = 0; r < ROWS && !hit; r++) {
          for (let c = 0; c < COLS && !hit; c++) {
            if (aliens[r][c] <= 0) continue;
            const ar = alienWorldRect(r, c);
            if (collideRect(bulletRect, ar)) {
              aliens[r][c] = Math.max(0, aliens[r][c] - 1);
              if (aliens[r][c] === 0) {
                addScore(ROW_POINTS[r]);
                syncAlienSpeed();
              }
              hit = true;
              const hitFreq = aliens[r][c] === 0 ? 140 + r * 15 : 220 + r * 18;
              beep(hitFreq, 0.05, "square", 0.06);
              break outer;
            }
          }
        }
      }

      if (!hit) {
        const bx = bullet.x + 1;
        const by = bullet.y + 4;
        for (const bunker of bunkers) {
          if (damageBunkerAtWorld(bunker, bx, by)) {
            hit = true;
            break;
          }
        }
      }

      if (bullet.y < 12 || bullet.x < -2 || bullet.x > W + 2 || hit) {
        playerBullets.splice(i, 1);
      }
    }
    if (phase === "upgrade_select") {
      elScore.textContent = String(score);
      if (score > highScore) {
        highScore = score;
        localStorage.setItem("si-high", String(highScore));
      }
      elHigh.textContent = String(highScore);
      elLevel.textContent = String(level);
      renderBuffs();
      return;
    }

    if (countAliens() === 0) {
      phase = "wave_clear";
      mysteryShip = null;
      wave++;
      if (waveClearTimeoutId !== null) clearTimeout(waveClearTimeoutId);
      waveClearTimeoutId = setTimeout(() => {
        waveClearTimeoutId = null;
        initAliens();
        bombs = [];
        playerBullets = [];
        phase = "playing";
        elStatus.textContent = `Wave ${wave}`;
      }, 650);
    }

    for (let i = bombs.length - 1; i >= 0; i--) {
      const bomb = bombs[i];
      bomb.y += BOMB_SPEED * dt;
      const br = { x: bomb.x - 2, y: bomb.y, w: 4, h: 10 };
      if (bomb.y > H) {
        bombs.splice(i, 1);
        continue;
      }

      let stopped = false;
      for (const bunker of bunkers) {
        if (damageBunkerAtWorld(bunker, bomb.x, bomb.y + 5)) {
          bombs.splice(i, 1);
          stopped = true;
          break;
        }
      }
      if (stopped) continue;

      const pr = { x: playerX, y: PLAYER_Y, w: PLAYER_W, h: PLAYER_H };
      if (collideRect(br, pr)) {
        bombs.splice(i, 1);
        if (isShieldActive()) {
          beep(260, 0.05, "triangle", 0.06);
        } else {
          loseLife();
        }
        continue;
      }
    }

    elScore.textContent = String(score);
    if (score > highScore) {
      highScore = score;
      localStorage.setItem("si-high", String(highScore));
    }
    elHigh.textContent = String(highScore);
    elLevel.textContent = String(level);
    renderBuffs();
    renderLives();
  }

  function loseLife() {
    lives -= 1;
    beep(90, 0.2, "sawtooth", 0.08);
    bombs = [];
    playerBullets = [];
    renderLives();
    if (lives <= 0) endGame(false);
    else {
      playerX = W / 2 - PLAYER_W / 2;
      elStatus.textContent = `Wave ${wave} · life lost`;
      setTimeout(() => {
        if (phase === "playing") elStatus.textContent = `Wave ${wave}`;
      }, 900);
    }
  }

  function endGame(won) {
    phase = won ? "win" : "gameover";
    elStatus.textContent = won
      ? "You cleared the wave chain! Enter menu"
      : "Game over — Enter / R for menu";
  }

  function startGame() {
    score = 0;
    lives = 3;
    wave = 1;
    level = 1;
    nextLevelScore = LEVEL_SCORE_BASE_STEP;
    pendingLevelUps = 0;
    gameTime = 0;
    hasDoubleShot = false;
    fireRateMultiplier = 1;
    shieldUntil = 0;
    scoreBoostUntil = 0;
    fireCooldown = 0;
    offeredUpgrades = [];
    levelBanner = null;
    phase = "playing";
    playerX = W / 2 - PLAYER_W / 2;
    playerBullets = [];
    bombs = [];
    initAliens();
    initBunkers();
    elScore.textContent = "0";
    elHigh.textContent = String(highScore);
    elLevel.textContent = String(level);
    renderBuffs();
    renderLives();
    elStatus.textContent = `Wave ${wave}`;
  }

  function resetToTitle() {
    if (waveClearTimeoutId !== null) {
      clearTimeout(waveClearTimeoutId);
      waveClearTimeoutId = null;
    }
    bombs = [];
    playerBullets = [];
    mysteryShip = null;
    offeredUpgrades = [];
    levelBanner = null;
    phase = "title";
    elStatus.textContent =
      "Arrow keys · Space shoot · Enter start · Esc menu · M mute";
    elLevel.textContent = "1";
    elBuffs.textContent = "";
    renderLives();
  }

  function renderBuffs() {
    const buffs = [];
    if (isShieldActive()) buffs.push(`Shield ${Math.ceil(shieldUntil - gameTime)}s`);
    if (isScoreBoostActive())
      buffs.push(`2x Score ${Math.ceil(scoreBoostUntil - gameTime)}s`);
    if (hasDoubleShot) buffs.push("Double Shot");
    if (fireRateMultiplier > 1) buffs.push(`Rapid x${fireRateMultiplier.toFixed(1)}`);
    elBuffs.textContent = buffs.join(" · ");
  }

  function renderLives() {
    elLives.innerHTML = "";
    const n = phase === "title" ? 3 : Math.max(0, lives);
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      s.className = "life-icon";
      elLives.appendChild(s);
    }
  }

  const animFrame = { tick: 0 };

  function drawAlienSprite(kind, frame, px, py, color) {
    const patterns = [
      [
        [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],
        [1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1],
        [0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      ],
      [
        [0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],
        [1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1],
        [0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0],
      ],
    ];
    const pat = patterns[frame % 2];
    ctx.fillStyle = color;
    for (let y = 0; y < pat.length; y++)
      for (let x = 0; x < pat[y].length; x++)
        if (pat[y][x])
          ctx.fillRect(px + x, py + y + (kind === 2 ? 1 : 0), 1, 1);
  }

  function drawAlien(r, c, tick, hp) {
    const { x, y } = alienWorldRect(r, c);
    const frame = Math.floor(tick * 3) % 2;
    let color = "#ff6bd6";
    if (r >= 4) color = "#ff3040";
    else if (r >= 2) color = "#ff41a8";
    else color = "#ff41d6";
    if (hp >= 4) color = "#ffffff";
    else if (hp === 3) color = "#ffd447";
    else if (hp === 2) color = "#7ec8ff";
    const kind = r >= 4 ? 2 : r >= 2 ? 1 : 0;
    drawAlienSprite(kind, frame, x, y, color);
  }

  function drawPlayer() {
    ctx.fillStyle = "#39ff14";
    const x = playerX;
    const y = PLAYER_Y;
    ctx.fillRect(x + 2, y + 4, 12, 6);
    ctx.fillRect(x + 6, y, 4, 8);
    ctx.fillRect(x, y + 6, 4, 4);
    ctx.fillRect(x + 12, y + 6, 4, 4);
  }

  function drawBunkers() {
    ctx.fillStyle = "#39ff14";
    for (const b of bunkers) {
      const { ox, oy, cells, cw, ch, bw, bh } = b;
      for (let y = 0; y < bh; y++)
        for (let x = 0; x < bw; x++)
          if (cells[y * bw + x])
            ctx.fillRect(ox + x * cw, oy + y * ch, cw, ch);
    }
  }

  function draw() {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    if (phase === "title") {
      ctx.fillStyle = "#39ff14";
      ctx.font = "bold 13px monospace";
      ctx.textAlign = "center";
      ctx.fillText("SPACE INVADERS", W / 2, H / 2 - 24);
      ctx.font = "10px monospace";
      ctx.fillStyle = "#e8f4e8";
      ctx.fillText("Press Enter to start", W / 2, H / 2 + 8);
      return;
    }

    drawBunkers();

    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (aliens[r][c] > 0) drawAlien(r, c, animFrame.tick, aliens[r][c]);

    if (mysteryShip) {
      ctx.fillStyle = "#ff3040";
      ctx.fillRect(mysteryShip.x, 36, 24, 8);
      ctx.fillRect(mysteryShip.x + 4, 34, 16, 4);
    }

    drawPlayer();

    ctx.fillStyle = "#39ff14";
    for (const bullet of playerBullets) ctx.fillRect(bullet.x, bullet.y, 2, 8);

    ctx.fillStyle = "#39ff14";
    for (const bomb of bombs) ctx.fillRect(bomb.x - 1, bomb.y, 3, 10);

    if (phase === "upgrade_select") {
      drawUpgradeMenu();
    }
    if (phase === "gameover") {
      overlayMessage("GAME OVER");
    } else if (phase === "win") {
      overlayMessage("YOU WIN");
    } else if (phase === "wave_clear") {
      overlayMessage(`WAVE ${wave}`, 0.85);
    }
    drawLevelBanner();
  }

  function drawUpgradeMenu() {
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(12, 64, W - 24, H - 124);
    ctx.strokeStyle = "#39ff14";
    ctx.lineWidth = 1;
    ctx.strokeRect(12.5, 64.5, W - 25, H - 125);
    ctx.textAlign = "center";
    ctx.fillStyle = "#39ff14";
    ctx.font = "bold 11px monospace";
    ctx.fillText(`LEVEL ${level} UPGRADE`, W / 2, 82);
    ctx.font = "8px monospace";
    ctx.fillStyle = "#e8f4e8";
    ctx.fillText("Arrows / 1-3 / Enter", W / 2, 93);

    for (let i = 0; i < offeredUpgrades.length; i++) {
      const option = offeredUpgrades[i];
      const y = 118 + i * 48;
      const selected = i === upgradeCursor;
      ctx.fillStyle = selected ? "rgba(57,255,20,0.16)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(24, y - 14, W - 48, 36);
      ctx.strokeStyle = selected ? "#39ff14" : "rgba(232,244,232,0.35)";
      ctx.strokeRect(24.5, y - 13.5, W - 49, 35);

      ctx.textAlign = "left";
      ctx.fillStyle = selected ? "#39ff14" : "#e8f4e8";
      ctx.font = "bold 10px monospace";
      ctx.fillText(`${i + 1}. ${option.label}`, 30, y);
      ctx.font = "8px monospace";
      ctx.fillStyle = "#d8e7d8";
      ctx.fillText(option.description, 30, y + 12);
    }
  }

  function drawLevelBanner() {
    if (!levelBanner) return;
    const p = Math.min(1, levelBanner.elapsed / levelBanner.duration);
    const fade = p < 0.2 ? p / 0.2 : p > 0.82 ? (1 - p) / 0.18 : 1;
    const y = 28 - (1 - Math.min(1, p * 3)) * 16;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, fade));
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(36, y - 14, W - 72, 28);
    ctx.strokeStyle = "#39ff14";
    ctx.strokeRect(36.5, y - 13.5, W - 73, 27);
    ctx.textAlign = "center";
    ctx.fillStyle = "#39ff14";
    ctx.font = "bold 10px monospace";
    ctx.fillText(levelBanner.title, W / 2, y - 1);
    ctx.font = "8px monospace";
    ctx.fillStyle = "#e8f4e8";
    ctx.fillText(levelBanner.subtitle, W / 2, y + 9);
    ctx.restore();
  }

  function overlayMessage(msg, alpha = 1) {
    ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#39ff14";
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "center";
    ctx.fillText(msg, W / 2, H / 2);
    ctx.font = "9px monospace";
    ctx.fillStyle = "#e8f4e8";
    ctx.fillText("Enter / R — menu", W / 2, H / 2 + 18);
  }

  let last = performance.now();
  function frame(now) {
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(rawDt, 0.05);

    animFrame.tick += dt;

    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  window.addEventListener("keydown", (e) => {
    const k = e.code;
    if (!input.keys[k]) input.edge[k] = true;
    input.keys[k] = true;
    if (k === "Space") e.preventDefault();
    if (k === "KeyM") {
      muted = !muted;
      elStatus.textContent = muted ? "Muted (M to unmute)" : `Wave ${wave}`;
      if (phase === "upgrade_select" && !muted)
        elStatus.textContent = `Level ${level} reached! Choose an upgrade`;
      if (phase === "title")
        elStatus.textContent = muted
          ? "Muted"
          : "Arrow keys · Space shoot · Enter start · Esc menu · M mute";
    }
    if (
      k === "Escape" &&
      (phase === "playing" || phase === "wave_clear" || phase === "upgrade_select")
    ) {
      e.preventDefault();
      resetToTitle();
    }
  });
  window.addEventListener("keyup", (e) => {
    input.keys[e.code] = false;
  });

  elHigh.textContent = String(highScore);
  elLevel.textContent = "1";
  renderBuffs();
  renderLives();
  requestAnimationFrame(frame);
})();
