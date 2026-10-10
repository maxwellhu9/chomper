// Screen flow + main loop.
//   title (chomp a menu bubble) → countdown → arcade → results → title
//                               → workout → summary → title
// The webcam feed is drawn mirrored as the background so you see yourself.
// Everything can be driven hands-free with your mouth; keyboard/mouse are
// optional shortcuts.
import { FaceTracker } from "./face";
import { Game, PLAYER_COLORS, type Player } from "./game";
import { Workout, WORKOUT_REPS, type WorkoutResult } from "./workout";
import { Tracks, newMouth, writeMouth, type Mouth, type Rect, type Track } from "./tracks";
import { sticker } from "./sticker";
import { sfx, toggleMute, unlockAudio } from "./audio";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("screen");
const ctx = canvas.getContext("2d")!;
const video = $<HTMLVideoElement>("cam");
const ui = {
  title: $("title"),
  status: $("status"),
  board: $("board"),
  countdown: $("countdown"),
  over: $("over"),
  overTitle: $("overTitle"),
  overBody: $("overBody"),
  overHint: $("overHint"),
  save: $<HTMLFormElement>("save"),
  name: $<HTMLInputElement>("name"),
  mute: $<HTMLButtonElement>("mute"),
};

type Screen = "loading" | "title" | "countdown" | "arcade" | "workout" | "results";
type Mode = "arcade" | "workout";
let screen: Screen = "loading";
let mode: Mode = "arcade";
let tracker: FaceTracker | null = null;
const tracks = new Tracks();
let game: Game | null = null;
let workout: Workout | null = null;
let W = 0;
let H = 0;

// Mouse fallback (no camera, or press F): pointer aims, hold click/space to chomp.
let mouseMode = false;
let mouseDown = false;
let spaceDown = false;
const mouseMouth = newMouth();

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const g of [game, workout]) {
    if (g) {
      g.w = W;
      g.h = H;
    }
  }
}
window.addEventListener("resize", resize);
resize();

/** Where the video lands on screen when scaled to cover the window. */
function videoRect(): Rect {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}

/** Every mouth currently on screen (all faces, or the mouse). Used by menus. */
function allMouths(): { mouth: Mouth; track?: Track }[] {
  if (mouseMode) {
    mouseMouth.found = true;
    mouseMouth.open = mouseDown || spaceDown;
    return [{ mouth: mouseMouth }];
  }
  const r = videoRect();
  return tracks.list
    .filter((t) => t.found)
    .map((t) => {
      const m = newMouth();
      writeMouth(t, r, m);
      return { mouth: m, track: t };
    });
}

// ---- players ↔ faces -----------------------------------------------------------
// Each player is bound to a face track. If someone's face drops out (looked
// away, walked off) and comes back as a new track, the player reclaims the
// nearest unowned face.
function bindMouths(players: { trackId: number; mouth: Mouth }[]) {
  if (mouseMode) {
    const open = mouseDown || spaceDown;
    Object.assign(players[0].mouth, mouseMouth, { found: true, open, jaw: open ? 0.6 : 0 });
    return;
  }
  const r = videoRect();
  const owned = new Set(players.map((p) => p.trackId));
  for (const p of players) {
    let t = tracks.get(p.trackId);
    if (!t) {
      const free = tracks.list.filter((c) => c.found && !owned.has(c.id));
      if (free.length) {
        const px = p.mouth.x;
        t = free.reduce((a, b) => (Math.abs(r.x + a.face.x * r.w - px) < Math.abs(r.x + b.face.x * r.w - px) ? a : b));
        p.trackId = t.id;
        owned.add(t.id);
      }
    }
    writeMouth(t, r, p.mouth);
  }
}

// ---- face photos ---------------------------------------------------------------
// On each eat we check if this is that player's widest-open chomp so far, and if
// so copy a square crop of their face from the video into a small canvas.
// drawImage is cheap, so this doesn't hitch the game.
const photos = new Map<number, { canvas: HTMLCanvasElement; jaw: number }>();
function snapPhoto(p: Player) {
  const t = tracks.get(p.trackId);
  if (mouseMode || !t?.found) return;
  let ph = photos.get(p.id);
  if (!ph) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    ph = { canvas: c, jaw: -1 };
    photos.set(p.id, ph);
  }
  const f = t.face;
  if (f.jaw <= ph.jaw) return;
  ph.jaw = f.jaw;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const size = Math.min(vh, f.faceH * vh * 1.7);
  // f.x is mirrored, so un-mirror it to find the crop in raw video pixels.
  const cx = (1 - f.x) * vw;
  const cy = ((f.y + f.topY) / 2) * vh;
  const pc = ph.canvas.getContext("2d")!;
  pc.save();
  pc.translate(256, 0);
  pc.scale(-1, 1);
  pc.drawImage(video, cx - size / 2, cy - size / 2, size, size, 0, 0, 256, 256);
  pc.restore();
}
function photoURL(id: number) {
  const ph = photos.get(id);
  return ph ? ph.canvas.toDataURL("image/jpeg", 0.75) : undefined;
}

// ---- persistence (localStorage, this browser only) -------------------------------
interface Entry {
  name: string;
  score: number;
  photo?: string;
  t?: number;
}
const SCORES = "chompcam-scores";
const WORKOUTS = "chompcam-workouts";
function load<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: just won't persist */
  }
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function renderBoard(highlight?: number) {
  const list = load<Entry>(SCORES);
  if (!list.length) {
    ui.board.innerHTML = "";
    return;
  }
  ui.board.innerHTML =
    "<div id='boardInner'><h3>HALL OF CHOMPS</h3><ol>" +
    list
      .map(
        (e, i) =>
          `<li class="${highlight && e.t === highlight ? "me" : ""}">
            <span>${i + 1}</span>
            ${e.photo ? `<img src="${e.photo}" alt="">` : "<span>😶</span>"}
            <span>${esc(e.name)}</span><span>${e.score.toLocaleString()}</span></li>`,
      )
      .join("") +
    "</ol></div>";
}

/** Consecutive days (ending today or yesterday) with at least one workout. */
function workoutStreak(): number {
  const days = new Set(load<WorkoutResult>(WORKOUTS).map((w) => new Date(w.date).toDateString()));
  let streak = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  while (days.has(d.toDateString())) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// ---- title menu: chomp a bubble to pick a mode ----------------------------------
interface Bubble {
  mode: Mode;
  emoji: string;
  label: string;
  sub: () => string;
  fx: number;
  fy: number;
  hold: number;
}
const MENU: Bubble[] = [
  { mode: "arcade", emoji: "🎮", label: "PLAY", sub: () => "1–4 players", fx: 0.3, fy: 0.68, hold: 0 },
  {
    mode: "workout",
    emoji: "💪",
    label: "JAW WORKOUT",
    sub: () => {
      const s = workoutStreak();
      return s ? `🔥 ${s}-day streak` : "daily exercise";
    },
    fx: 0.7,
    fy: 0.68,
    hold: 0,
  },
];
const MENU_HOLD = 0.8;
const bubbleR = () => Math.min(W, H) * 0.11;

function updateMenu(dt: number) {
  const mouths = allMouths();
  for (const b of MENU) {
    const bx = W * b.fx;
    const by = H * b.fy;
    const chomping = mouths.some(({ mouth: m }) => m.open && Math.hypot(m.x - bx, m.y - by) < bubbleR() + m.reach * 0.5);
    b.hold = chomping ? b.hold + dt : Math.max(0, b.hold - dt * 2);
    if (b.hold >= MENU_HOLD) {
      MENU.forEach((x) => (x.hold = 0));
      startCountdown(b.mode);
      return;
    }
  }
}

function drawMenu(now: number) {
  const R = bubbleR();
  for (const b of MENU) {
    const x = W * b.fx;
    const y = H * b.fy + Math.sin(now / 400 + b.fx * 10) * 6;
    ctx.fillStyle = "rgba(16,12,40,0.78)";
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.stroke();
    if (b.hold > 0) {
      ctx.strokeStyle = "#5aff8c";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + (b.hold / MENU_HOLD) * Math.PI * 2);
      ctx.stroke();
    }
    const s = sticker(b.emoji, R * 0.75);
    ctx.drawImage(s, x - s.width / 2, y - s.height / 2 - R * 0.18);
    text(b.label, x, y + R * 0.5, Math.max(16, R * 0.2), "#ffd93d");
    text(b.sub(), x, y + R + 24, 20, "#fff");
  }
}

function drawFaces() {
  // Show every detected face so people can see they've been picked up.
  allMouths().forEach(({ mouth: m }, i) => {
    if (mouseMode) return;
    ctx.lineWidth = 4;
    ctx.strokeStyle = PLAYER_COLORS[i % PLAYER_COLORS.length];
    ctx.setLineDash(m.open ? [] : [10, 10]);
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.reach, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

function text(s: string, x: number, y: number, size: number, color: string) {
  ctx.font = `900 ${size}px "Rubik", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

// ---- screens ------------------------------------------------------------------
function show(s: Screen) {
  screen = s;
  ui.title.classList.toggle("hidden", s !== "title" && s !== "loading");
  ui.board.classList.toggle("hidden", s !== "title");
  ui.countdown.classList.toggle("hidden", s !== "countdown");
  ui.over.classList.toggle("hidden", s !== "results");
}

let countdownT = 0;
function startCountdown(m: Mode) {
  unlockAudio();
  mode = m;
  photos.clear();
  if (m === "arcade") {
    // Lock in whoever is in frame right now, numbered left to right.
    const faces = mouseMode
      ? [{ id: -1, x: 0 }]
      : tracks.list.filter((t) => t.found).map((t) => ({ id: t.id, x: t.face.x }));
    faces.sort((a, b) => a.x - b.x);
    const players: Player[] = faces.slice(0, 4).map((f, i) => ({
      id: i + 1,
      trackId: f.id,
      color: PLAYER_COLORS[i],
      mouth: newMouth(),
      score: 0,
      combo: 0,
      bestCombo: 0,
      eaten: 0,
      lives: 3,
      fever: 0,
      magnet: 0,
      chompAnim: 0,
      out: false,
    }));
    if (!players.length) return; // nobody in frame
    game = new Game(W, H, players);
    game.onEat = (p, kind) => kind !== "bomb" && snapPhoto(p);
    workout = null;
  } else {
    workout = new Workout(W, H);
    game = null;
  }
  countdownT = 3;
  sfx.tick();
  show("countdown");
}

// The workout follows one face: whoever is most central at the start.
const workoutPlayer = { trackId: -1, mouth: newMouth() };

let resultsAt = 0;
let resultsPending = false;
let resultsHold = 0;
let lastSaved: number | undefined;

function showArcadeResults() {
  const g = game!;
  const ranked = [...g.players].sort((a, b) => b.score - a.score);
  if (g.multi) {
    const tie = ranked[0].score === ranked[1].score;
    ui.overTitle.textContent = tie ? "TIE!" : `P${ranked[0].id} WINS! 👑`;
    ui.overTitle.style.color = tie ? "" : ranked[0].color;
  } else {
    ui.overTitle.textContent = g.players[0].lives <= 0 ? "KABOOM!" : "TIME!";
    ui.overTitle.style.color = "";
  }
  ui.overBody.innerHTML =
    `<div class="results">` +
    ranked
      .map((p) => {
        const url = photoURL(p.id);
        return `<div class="result" style="--c:${g.multi ? p.color : "#ffd93d"}">
          ${url ? `<img src="${url}" alt="">` : `<div class="noface">😶</div>`}
          ${g.multi ? `<span style="color:${p.color}">P${p.id}</span>` : ""}
          <span class="score">${p.score.toLocaleString()}</span>
          <span class="meta">${p.eaten} eaten · best combo ${p.bestCombo}</span></div>`;
      })
      .join("") +
    `</div><p class="meta">${mouseMode ? "" : "📸 your biggest chomp"}</p>`;
  ui.save.classList.remove("hidden");
  ui.name.placeholder = g.multi ? "winner's name" : "your name";
  ui.name.value = "";
  finishResults();
}

function saveArcade() {
  const g = game;
  if (!g) return;
  const ranked = [...g.players].sort((a, b) => b.score - a.score);
  const typed = ui.name.value.trim().toUpperCase();
  const t = Date.now();
  const entries = ranked
    .filter((p) => p.score > 0)
    .map((p, i) => ({
      name: i === 0 && typed ? typed : g.multi ? `PLAYER ${p.id}` : "ANON",
      score: p.score,
      photo: photos.has(p.id) ? photos.get(p.id)!.canvas.toDataURL("image/jpeg", 0.6) : undefined,
      t: t + i,
    }));
  store(SCORES, [...load<Entry>(SCORES), ...entries].sort((a, b) => b.score - a.score).slice(0, 8));
  lastSaved = entries[0]?.t;
}

function showWorkoutResults() {
  const r = workout!.result();
  const history = load<WorkoutResult>(WORKOUTS);
  const prev = history[history.length - 1];
  history.push(r);
  store(WORKOUTS, history.slice(-60));

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const delta = prev ? Math.round((r.avgOpen - prev.avgOpen) * 100) : null;
  const streak = workoutStreak();
  ui.overTitle.textContent = "WORKOUT DONE 💪";
  ui.overTitle.style.color = "";
  ui.overBody.innerHTML = `
    <div class="stats">
      <div><b>${r.reps}</b>reps</div>
      <div><b>${pct(r.avgOpen)}</b>avg opening</div>
      <div><b>${pct(r.bestOpen)}</b>best opening</div>
    </div>
    <p>${
      delta === null
        ? "First session logged. Come back tomorrow to start a streak!"
        : `<span class="delta" style="color:${delta >= 0 ? "#5aff8c" : "#ffb347"}">${delta >= 0 ? "+" : ""}${delta}%</span> vs last session`
    }${streak > 1 ? ` · 🔥 ${streak}-day streak` : ""}</p>
    <canvas id="spark" width="560" height="90"></canvas>
    <p class="meta">avg opening, last ${Math.min(14, history.length)} sessions · ${r.secs}s</p>`;
  drawSpark($<HTMLCanvasElement>("spark"), history.slice(-14).map((h) => h.avgOpen));
  ui.save.classList.add("hidden");
  finishResults();
}

function drawSpark(c: HTMLCanvasElement, vals: number[]) {
  const g = c.getContext("2d")!;
  const pad = 10;
  // Zoom the y-axis to the data so small day-to-day gains are visible.
  const lo = Math.min(...vals) - 0.05;
  const hi = Math.max(...vals) + 0.05;
  const xs = (i: number) => pad + (i / Math.max(1, vals.length - 1)) * (c.width - pad * 2);
  const ys = (v: number) => c.height - pad - ((v - lo) / (hi - lo)) * (c.height - pad * 2);
  g.strokeStyle = "#7cf5ff";
  g.lineWidth = 4;
  g.lineJoin = "round";
  g.beginPath();
  vals.forEach((v, i) => (i ? g.lineTo(xs(i), ys(v)) : g.moveTo(xs(i), ys(v))));
  g.stroke();
  vals.forEach((v, i) => {
    g.fillStyle = i === vals.length - 1 ? "#ffd93d" : "#7cf5ff";
    g.beginPath();
    g.arc(xs(i), ys(v), i === vals.length - 1 ? 7 : 4, 0, Math.PI * 2);
    g.fill();
  });
}

const CONTINUE_DELAY = 3; // seconds before hands-free continue arms, so the last chomp doesn't skip it
function finishResults() {
  resultsPending = false;
  resultsAt = performance.now();
  resultsHold = 0;
  ui.overHint.textContent = "";
  show("results");
}

function leaveResults() {
  if (screen !== "results") return;
  if (mode === "arcade") saveArcade();
  ui.name.blur();
  toTitle();
}

ui.save.addEventListener("submit", (e) => {
  e.preventDefault();
  leaveResults();
});

function toTitle() {
  renderBoard(lastSaved);
  ui.status.textContent = mouseMode ? "hold click on a bubble to start" : "chomp a bubble to start 😮";
  game = null;
  workout = null;
  show("title");
}

// ---- input --------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  unlockAudio();
  if (document.activeElement === ui.name) {
    if (e.key === "Escape") leaveResults();
    return;
  }
  if (e.key === " ") spaceDown = true;
  if (screen === "title" && e.key === "Enter") startCountdown("arcade");
  if (screen === "title" && (e.key === "w" || e.key === "W")) startCountdown("workout");
  if (screen === "results" && (e.key === "Enter" || e.key === "Escape")) leaveResults();
  if (e.key === "Escape" && (screen === "arcade" || screen === "workout")) toTitle();
  if (e.key === "m" || e.key === "M") ui.mute.textContent = toggleMute() ? "🔇" : "🔊";
  if ((e.key === "f" || e.key === "F") && screen === "title") {
    mouseMode = !mouseMode;
    toTitle();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") spaceDown = false;
});
canvas.addEventListener("pointermove", (e) => {
  mouseMouth.x = e.clientX;
  mouseMouth.y = e.clientY;
});
canvas.addEventListener("pointerdown", () => {
  mouseDown = true;
  unlockAudio();
});
window.addEventListener("pointerup", () => (mouseDown = false));
ui.mute.addEventListener("click", (e) => {
  e.stopPropagation();
  ui.mute.textContent = toggleMute() ? "🔇" : "🔊";
});

// ---- main loop ------------------------------------------------------------------
let last = performance.now();

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); // clamp so a tab switch doesn't teleport items
  last = now;
  if (tracker && !mouseMode && tracker.update(video)) tracks.update(tracker.faces, now);

  // Background: mirrored webcam, darkened a little so items pop.
  ctx.fillStyle = "#0d0b1e";
  ctx.fillRect(0, 0, W, H);
  if (!mouseMode && video.readyState >= 2) {
    const r = videoRect();
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, r.x, r.y, r.w, r.h);
    ctx.restore();
    ctx.fillStyle = "rgba(13,11,30,0.4)";
    ctx.fillRect(0, 0, W, H);
  }

  switch (screen) {
    case "title":
      drawFaces();
      drawMenu(now);
      updateMenu(dt);
      if (!mouseMode && tracker) {
        const n = tracks.list.filter((t) => t.found).length;
        text(n ? `${n} face${n > 1 ? "s" : ""} ready` : "step into the frame 👀", W / 2, H - 40, 26, n ? "#5aff8c" : "#ffd93d");
      }
      break;

    case "countdown": {
      const prev = Math.ceil(countdownT);
      countdownT -= dt;
      const cur = Math.ceil(countdownT);
      if (cur !== prev) cur > 0 ? sfx.tick() : sfx.go();
      const n = game?.players.length ?? 1;
      ui.countdown.textContent =
        n > 1 && countdownT > 2.2 ? `${n} PLAYERS` : cur > 0 ? String(cur) : mode === "arcade" ? "CHOMP!" : "GO!";
      if (game) {
        bindMouths(game.players);
        game.draw(ctx, now);
      }
      if (countdownT <= -0.5) {
        if (mode === "workout") {
          // Pick the face closest to the centre of the screen.
          const r = videoRect();
          const c = tracks.list.filter((t) => t.found).sort((a, b) => Math.abs(a.face.x - 0.5) - Math.abs(b.face.x - 0.5))[0];
          workoutPlayer.trackId = c?.id ?? -1;
          workoutPlayer.mouth.x = r.x + r.w / 2;
          show("workout");
        } else show("arcade");
      }
      break;
    }

    case "arcade": {
      const g = game!;
      bindMouths(g.players);
      g.update(dt);
      g.draw(ctx, now);
      if (g.over && !resultsPending) {
        resultsPending = true; // show results after a beat so the last explosion lands
        setTimeout(showArcadeResults, 900);
      }
      break;
    }

    case "workout": {
      const w = workout!;
      bindMouths([workoutPlayer]);
      w.update(dt, workoutPlayer.mouth);
      w.draw(ctx, workoutPlayer.mouth, now);
      if (w.done) {
        showWorkoutResults();
      }
      break;
    }

    case "results": {
      // Hands-free continue: after a short delay, hold your mouth open 1s.
      if (game && mode === "arcade") game.update(dt), game.draw(ctx, now);
      const armed = (now - resultsAt) / 1000 > CONTINUE_DELAY;
      const open = allMouths().some(({ mouth }) => mouth.open);
      resultsHold = armed && open ? resultsHold + dt : 0;
      const hint = mouseMode ? "press Enter to continue" : "open wide to continue";
      ui.overHint.textContent = !armed
        ? " "
        : resultsHold > 0
          ? `continuing${".".repeat(1 + Math.floor(resultsHold * 3))}`
          : mode === "arcade"
            ? `type a name + Enter to save · or ${hint}`
            : hint;
      if (resultsHold >= 1) leaveResults();
      break;
    }
  }
  requestAnimationFrame(frame);
}

// ---- boot ---------------------------------------------------------------------
async function boot() {
  requestAnimationFrame(frame);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    tracker = await FaceTracker.create();
  } catch (err) {
    console.warn("camera/face tracker unavailable, using mouse mode", err);
    mouseMode = true;
  }
  toTitle();
}
boot();

// Dev-only console handle, e.g. `chomp.game.timeLeft = 3` to jump to the end.
if (import.meta.env.DEV)
  Object.assign(window, {
    chomp: {
      get game() {
        return game;
      },
      get workout() {
        return workout;
      },
      tracks,
      mouse: mouseMouth,
      WORKOUT_REPS,
    },
  });
