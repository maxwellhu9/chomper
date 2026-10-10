// Screen flow + main loop: title → countdown → play → game over → title.
// The webcam feed is drawn mirrored as the background so you see yourself.
import { FaceTracker } from "./face";
import { Game, type Mouth } from "./game";
import { sfx, toggleMute, unlockAudio } from "./audio";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("screen");
const ctx = canvas.getContext("2d")!;
const video = $<HTMLVideoElement>("cam");
const photo = $<HTMLCanvasElement>("photo");
const photoCtx = photo.getContext("2d")!;
const ui = {
  title: $("title"),
  status: $("status"),
  board: $("board"),
  countdown: $("countdown"),
  over: $("over"),
  final: $("final"),
  save: $<HTMLFormElement>("save"),
  name: $<HTMLInputElement>("name"),
  mute: $<HTMLButtonElement>("mute"),
};

type Screen = "loading" | "title" | "countdown" | "play" | "over";
let screen: Screen = "loading";
let tracker: FaceTracker | null = null;
let game: Game | null = null;
let W = 0;
let H = 0;

// Hysteresis: "open" needs jaw > 0.35, but stays open until jaw < 0.22.
// Without the gap, a jaw hovering around one threshold flickers open/closed.
const JAW_OPEN = 0.35;
const JAW_CLOSE = 0.22;
const mouth: Mouth = { x: 0, y: 0, open: false, reach: 80, found: false };

// Mouse fallback (no camera, or press F): mouse aims, hold click/space to chomp.
let mouseMode = false;
let mouseDown = false;
let spaceDown = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (game) {
    game.w = W;
    game.h = H;
  }
}
window.addEventListener("resize", resize);
resize();

/** Where the video lands on screen when scaled to cover the window. */
function videoRect() {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}

function updateMouth() {
  if (mouseMode || !tracker) {
    mouth.found = mouseMode;
    mouth.open = mouseDown || spaceDown;
    mouth.reach = 70;
    return;
  }
  tracker.update(video);
  const f = tracker.state;
  const r = videoRect();
  mouth.found = f.found;
  mouth.x = r.x + f.x * r.w;
  mouth.y = r.y + f.y * r.h;
  mouth.reach = Math.max(50, f.scale * r.w * 0.38);
  mouth.open = mouth.open ? f.jaw > JAW_CLOSE : f.jaw > JAW_OPEN;
}

// ---- best-chomp photo -------------------------------------------------------
// On each eat we check if this is your widest-open chomp so far, and if so copy
// a square crop of your face from the video into a small canvas. drawImage is
// cheap, so this doesn't hitch the game.
let bestJaw = -1;
function snapPhoto() {
  if (mouseMode || !tracker || !tracker.state.found) return;
  const f = tracker.state;
  if (f.jaw <= bestJaw) return;
  bestJaw = f.jaw;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const size = Math.min(vh, f.scale * vw * 3.2);
  // f.x is mirrored, so un-mirror it to find the crop in raw video pixels.
  const cx = (1 - f.x) * vw;
  const cy = f.y * vh - size * 0.18; // shift up so the whole face fits
  photoCtx.save();
  photoCtx.translate(photo.width, 0);
  photoCtx.scale(-1, 1);
  photoCtx.drawImage(video, cx - size / 2, cy - size / 2, size, size, 0, 0, photo.width, photo.height);
  photoCtx.restore();
}

// ---- leaderboard (localStorage, this browser only) ---------------------------
interface Entry {
  name: string;
  score: number;
  photo?: string;
}
const KEY = "chompcam-scores";
function loadScores(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
function saveScore(e: Entry) {
  const list = [...loadScores(), e].sort((a, b) => b.score - a.score).slice(0, 8);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: leaderboard just won't persist */
  }
  return list;
}
function renderBoard(highlight?: Entry) {
  const list = loadScores();
  if (!list.length) {
    ui.board.innerHTML = "";
    return;
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  ui.board.innerHTML =
    "<h3>HALL OF CHOMPS</h3><ol>" +
    list
      .map(
        (e, i) =>
          `<li class="${highlight && e.score === highlight.score && e.name === highlight.name ? "me" : ""}">
            <span>${i + 1}</span>
            ${e.photo ? `<img src="${e.photo}" alt="">` : "<span>😶</span>"}
            <span>${esc(e.name)}</span><span>${e.score.toLocaleString()}</span></li>`,
      )
      .join("") +
    "</ol>";
}

// ---- screens -----------------------------------------------------------------
function show(s: Screen) {
  screen = s;
  ui.title.classList.toggle("hidden", s !== "title" && s !== "loading");
  ui.countdown.classList.toggle("hidden", s !== "countdown");
  ui.over.classList.toggle("hidden", s !== "over");
}

let countdownT = 0;
function startCountdown() {
  unlockAudio();
  game = new Game(W, H);
  game.onEat = (kind) => kind !== "bomb" && snapPhoto();
  bestJaw = -1;
  photoCtx.clearRect(0, 0, photo.width, photo.height);
  countdownT = 3;
  ui.countdown.textContent = "3";
  sfx.tick();
  show("countdown");
}

function gameOver() {
  const g = game!;
  $("overTitle").textContent = g.lives <= 0 ? "KABOOM!" : "TIME!";
  ui.final.innerHTML = `<b>${g.score.toLocaleString()}</b><br>${g.eaten} eaten · best combo ${g.bestCombo}`;
  if (bestJaw < 0) {
    photoCtx.font = "160px sans-serif";
    photoCtx.textAlign = "center";
    photoCtx.textBaseline = "middle";
    photoCtx.fillText("😶", 128, 140);
  }
  ui.name.value = "";
  show("over");
  setTimeout(() => ui.name.focus(), 50);
}

ui.save.addEventListener("submit", (e) => {
  e.preventDefault();
  const g = game!;
  const entry: Entry = {
    name: (ui.name.value.trim() || "ANON").toUpperCase(),
    score: g.score,
    photo: bestJaw >= 0 ? photo.toDataURL("image/jpeg", 0.7) : undefined,
  };
  saveScore(entry);
  ui.name.blur();
  toTitle(entry);
});

function toTitle(highlight?: Entry) {
  renderBoard(highlight);
  ui.status.textContent = mouseMode ? "click or press Enter to start" : "open your mouth wide to start 😮";
  game = null;
  holdOpen = 0;
  show("title");
}

// ---- input -------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (document.activeElement === ui.name) {
    if (e.key === "Escape") {
      ui.name.blur();
      toTitle();
    }
    return;
  }
  if (e.key === " ") spaceDown = true;
  if (e.key === "Enter" && screen === "title") startCountdown();
  if (e.key === "m" || e.key === "M") ui.mute.textContent = toggleMute() ? "🔇" : "🔊";
  if ((e.key === "f" || e.key === "F") && screen !== "loading") {
    mouseMode = !mouseMode;
    if (screen === "title") toTitle();
  }
  unlockAudio();
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") spaceDown = false;
});
canvas.addEventListener("pointermove", (e) => {
  if (mouseMode) {
    mouth.x = e.clientX;
    mouth.y = e.clientY;
  }
});
canvas.addEventListener("pointerdown", () => (mouseDown = true));
window.addEventListener("pointerup", () => (mouseDown = false));
ui.title.addEventListener("click", () => screen === "title" && startCountdown());
ui.mute.addEventListener("click", (e) => {
  e.stopPropagation();
  ui.mute.textContent = toggleMute() ? "🔇" : "🔊";
});

// ---- main loop ---------------------------------------------------------------
// Hands-free start: hold your mouth open for 1 second on the title screen.
let holdOpen = 0;
const HOLD_TO_START = 1;
let last = performance.now();

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); // clamp so a tab switch doesn't teleport items
  last = now;
  updateMouth();

  // Background: mirrored webcam, darkened a little so emoji pop.
  ctx.fillStyle = "#0d0b1e";
  ctx.fillRect(0, 0, W, H);
  if (!mouseMode && video.readyState >= 2) {
    const r = videoRect();
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, r.x, r.y, r.w, r.h);
    ctx.restore();
    ctx.fillStyle = "rgba(13,11,30,0.35)";
    ctx.fillRect(0, 0, W, H);
  }

  if (screen === "title") {
    holdOpen = mouth.found && mouth.open ? holdOpen + dt : 0;
    if (mouth.found) drawStartRing(holdOpen / HOLD_TO_START);
    if (holdOpen >= HOLD_TO_START) startCountdown();
  } else if (screen === "countdown") {
    const prev = Math.ceil(countdownT);
    countdownT -= dt;
    const cur = Math.ceil(countdownT);
    if (cur !== prev) {
      if (cur > 0) sfx.tick();
      else sfx.go();
    }
    ui.countdown.textContent = cur > 0 ? String(cur) : "CHOMP!";
    if (countdownT <= -0.5) show("play");
    game!.draw(ctx, mouth);
  } else if (screen === "play" || screen === "over") {
    game!.update(dt, mouth);
    game!.draw(ctx, mouth);
    if (screen === "play" && game!.over) setTimeout(gameOver, 900);
    if (game!.over) screen = screen === "play" ? "over" : screen; // only schedule once
  }

  if (!mouth.found && !mouseMode && screen !== "loading" && tracker) {
    ctx.font = `800 26px "Rubik", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd93d";
    ctx.fillText("can't see your face 👀", W / 2, H - 50);
  }
  requestAnimationFrame(frame);
}

function drawStartRing(t: number) {
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.arc(mouth.x, mouth.y, mouth.reach, 0, Math.PI * 2);
  ctx.stroke();
  if (t > 0) {
    ctx.strokeStyle = "#5aff8c";
    ctx.beginPath();
    ctx.arc(mouth.x, mouth.y, mouth.reach, -Math.PI / 2, -Math.PI / 2 + Math.min(1, t) * Math.PI * 2);
    ctx.stroke();
  }
}

// ---- boot --------------------------------------------------------------------
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

// Dev-only console handle, e.g. `chomp.game.timeLeft = 3` to jump to game over.
if (import.meta.env.DEV) Object.assign(window, { chomp: { get game() { return game; }, mouth } });
