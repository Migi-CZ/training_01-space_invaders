(function () {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const elScore = document.getElementById("score");
  const elHigh = document.getElementById("highScore");
  const elLives = document.getElementById("lives");
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
  const BOMB_SPEED = 70;
  /** Vertical drop when formation hits screen edge (smaller = slower descent). */
  const FORMATION_DROP = 10;

  /** @type {'title'|'playing'|'wave_clear'|'gameover'|'win'} */
  let phase = "title";
  let score = 0;
  let highScore = Number(localStorage.getItem("si-high") || 0) || 0;
  let lives = 3;
  let wave = 1;

  /** @type {{keys: Record<string,boolean>, edge: Record<string,boolean>}} */
  const input = { keys: {}, edge: {} };

  let formationX = 40;
  let formationY = 56;
  let alienDir = 1;
  /** @type {boolean[][]} */
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

  /** @type {{ x: number, y: number, active: boolean } | null} */
  let playerBullet = null;

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
    aliens = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(true);
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
      for (let c = 0; c < COLS; c++) if (aliens[r][c]) n++;
    return n;
  }

  function formationBounds() {
    let minC = COLS,
      maxC = -1,
      minR = ROWS,
      maxR = -1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!aliens[r][c]) continue;
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

  function tryShootPlayer() {
    if (playerBullet && playerBullet.active) return;
    playerBullet = {
      x: playerX + PLAYER_W / 2 - 1,
      y: PLAYER_Y - 4,
      active: true,
    };
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
    input.edge = {};

    if (phase === "title") {
      if (input.keys["Enter"]) startGame();
      return;
    }
    if (phase === "gameover" || phase === "win") {
      if (input.keys["Enter"] || input.keys["KeyR"]) resetToTitle();
      return;
    }
    if (phase === "wave_clear") {
      return;
    }

    if (phase !== "playing") return;

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

    if (playerBullet && playerBullet.active) {
      playerBullet.y -= BULLET_SPEED * dt;
      const bulletRect = {
        x: playerBullet.x,
        y: playerBullet.y,
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
          score += bonus;
          mysteryShip = null;
          mysteryAcc = 0;
          hit = true;
          beep(240, 0.12, "triangle", 0.07);
        }
      }

      if (!hit) {
        outer: for (let r = 0; r < ROWS && !hit; r++) {
          for (let c = 0; c < COLS && !hit; c++) {
            if (!aliens[r][c]) continue;
            const ar = alienWorldRect(r, c);
            if (collideRect(bulletRect, ar)) {
              aliens[r][c] = false;
              score += ROW_POINTS[r];
              hit = true;
              syncAlienSpeed();
              beep(140 + r * 15, 0.05, "square", 0.06);
              break outer;
            }
          }
        }
      }

      if (!hit) {
        const bx = playerBullet.x + 1;
        const by = playerBullet.y + 4;
        for (const bunker of bunkers) {
          if (damageBunkerAtWorld(bunker, bx, by)) {
            hit = true;
            break;
          }
        }
      }

      if (playerBullet.y < 12 || hit) playerBullet = null;

      if (countAliens() === 0) {
        phase = "wave_clear";
        mysteryShip = null;
        wave++;
        if (waveClearTimeoutId !== null) clearTimeout(waveClearTimeoutId);
        waveClearTimeoutId = setTimeout(() => {
          waveClearTimeoutId = null;
          initAliens();
          bombs = [];
          playerBullet = null;
          phase = "playing";
          elStatus.textContent = `Wave ${wave}`;
        }, 650);
      }
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
        loseLife();
        continue;
      }
    }

    elScore.textContent = String(score);
    if (score > highScore) {
      highScore = score;
      localStorage.setItem("si-high", String(highScore));
    }
    elHigh.textContent = String(highScore);
    renderLives();
  }

  function loseLife() {
    lives -= 1;
    beep(90, 0.2, "sawtooth", 0.08);
    bombs = [];
    playerBullet = null;
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
    phase = "playing";
    playerX = W / 2 - PLAYER_W / 2;
    playerBullet = null;
    bombs = [];
    initAliens();
    initBunkers();
    elScore.textContent = "0";
    elHigh.textContent = String(highScore);
    renderLives();
    elStatus.textContent = `Wave ${wave}`;
  }

  function resetToTitle() {
    if (waveClearTimeoutId !== null) {
      clearTimeout(waveClearTimeoutId);
      waveClearTimeoutId = null;
    }
    bombs = [];
    playerBullet = null;
    mysteryShip = null;
    phase = "title";
    elStatus.textContent =
      "Arrow keys · Space shoot · Enter start · Esc menu · M mute";
    renderLives();
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

  function drawAlien(r, c, tick) {
    const { x, y } = alienWorldRect(r, c);
    const frame = Math.floor(tick * 3) % 2;
    let color = "#ff6bd6";
    if (r >= 4) color = "#ff3040";
    else if (r >= 2) color = "#ff41a8";
    else color = "#ff41d6";
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
        if (aliens[r][c]) drawAlien(r, c, animFrame.tick);

    if (mysteryShip) {
      ctx.fillStyle = "#ff3040";
      ctx.fillRect(mysteryShip.x, 36, 24, 8);
      ctx.fillRect(mysteryShip.x + 4, 34, 16, 4);
    }

    drawPlayer();

    if (playerBullet && playerBullet.active) {
      ctx.fillStyle = "#39ff14";
      ctx.fillRect(playerBullet.x, playerBullet.y, 2, 8);
    }

    ctx.fillStyle = "#39ff14";
    for (const bomb of bombs) ctx.fillRect(bomb.x - 1, bomb.y, 3, 10);

    if (phase === "gameover") {
      overlayMessage("GAME OVER");
    } else if (phase === "win") {
      overlayMessage("YOU WIN");
    } else if (phase === "wave_clear") {
      overlayMessage(`WAVE ${wave}`, 0.85);
    }
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
      if (phase === "title")
        elStatus.textContent = muted
          ? "Muted"
          : "Arrow keys · Space shoot · Enter start · Esc menu · M mute";
    }
    if (
      k === "Escape" &&
      (phase === "playing" || phase === "wave_clear")
    ) {
      e.preventDefault();
      resetToTitle();
    }
  });
  window.addEventListener("keyup", (e) => {
    input.keys[e.code] = false;
  });

  elHigh.textContent = String(highScore);
  renderLives();
  requestAnimationFrame(frame);
})();
