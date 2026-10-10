// Core gameplay: items get tossed up from below the screen in arcs (Fruit
// Ninja style), and you eat them by opening your mouth when one is close.
// Everything here is in canvas pixels; `dt` is seconds since the last frame.
import { sfx } from "./audio";

export interface Mouth {
  x: number;
  y: number;
  open: boolean;
  reach: number; // eat radius in px, grows when you lean closer to the camera
  found: boolean;
}

type Kind = "food" | "gold" | "bomb" | "heart";

interface Item {
  kind: Kind;
  emoji: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  vr: number;
  dead: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  size: number;
}

const FOODS = ["🍕", "🍔", "🍩", "🍓", "🍣", "🌮", "🍪", "🍉", "🧁", "🍟", "🍌", "🥐"];
const FOOD_COLORS = ["#ffb347", "#ff6b6b", "#ffd93d", "#6bcB77", "#ff8fab", "#c780fa"];
export const ROUND_SECONDS = 60;
const MAX_LIVES = 5;

export class Game {
  items: Item[] = [];
  particles: Particle[] = [];
  texts: FloatText[] = [];
  score = 0;
  combo = 0;
  bestCombo = 0;
  eaten = 0;
  lives = 3;
  timeLeft = ROUND_SECONDS;
  over = false;

  private spawnTimer = 0.8;
  private shake = 0;
  private flash = 0;
  private flashColor = "255,255,255";
  private slowmo = 0; // seconds of slow motion remaining
  private chompAnim = 0;
  /** Called on every successful eat so main.ts can grab a photo of your face. */
  onEat?: (kind: Kind) => void;

  constructor(
    public w: number,
    public h: number,
  ) {}

  /** 0 at the start of the round, 1 at the end. Drives difficulty. */
  get progress() {
    return 1 - this.timeLeft / ROUND_SECONDS;
  }

  get multiplier() {
    return Math.min(8, 1 + Math.floor(this.combo / 5)); // capped so one long streak doesn't dwarf everything
  }

  update(rawDt: number, mouth: Mouth) {
    // Slow-mo scales world time but not the round timer's feel too harshly.
    const dt = rawDt * (this.slowmo > 0 ? 0.35 : 1);
    this.slowmo = Math.max(0, this.slowmo - rawDt);
    this.shake = Math.max(0, this.shake - rawDt * 30);
    this.flash = Math.max(0, this.flash - rawDt * 3);
    this.chompAnim = Math.max(0, this.chompAnim - rawDt * 5);

    if (!this.over) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0 || this.lives <= 0) {
        this.timeLeft = Math.max(0, this.timeLeft);
        this.over = true;
        sfx.over();
      }
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) this.spawnWave();
    }

    const g = this.h * 0.9; // gravity, px/s²
    for (const it of this.items) {
      it.vy += g * dt;
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.rot += it.vr * dt;

      if (!this.over && mouth.found && mouth.open && !it.dead) {
        if (Math.hypot(it.x - mouth.x, it.y - mouth.y) < mouth.reach + it.r * 0.6) this.eat(it);
      }
      // Fell off the bottom: missing food breaks your combo.
      if (!it.dead && it.vy > 0 && it.y > this.h + it.r * 2) {
        it.dead = true;
        if ((it.kind === "food" || it.kind === "gold") && !this.over) {
          if (this.combo >= 3) this.text(it.x, this.h - 60, "combo lost", "#aaa", 28);
          this.combo = 0;
          sfx.miss();
        }
      }
    }
    this.items = this.items.filter((i) => !i.dead);

    for (const p of this.particles) {
      p.vy += g * 0.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= rawDt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) {
      t.y -= 60 * rawDt;
      t.life -= rawDt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
  }

  private spawnWave() {
    const p = this.progress;
    // Waves get bigger and faster as the round goes on.
    const count = 1 + (Math.random() < 0.25 + p * 0.5 ? 1 : 0) + (Math.random() < p * 0.4 ? 1 : 0);
    for (let i = 0; i < count; i++) this.spawn();
    this.spawnTimer = 1.0 - p * 0.55 + Math.random() * 0.3;
  }

  private spawn() {
    const p = this.progress;
    const roll = Math.random();
    let kind: Kind = "food";
    if (roll < 0.1 + p * 0.18) kind = "bomb";
    else if (roll < 0.16 + p * 0.18) kind = "gold";
    else if (roll < 0.175 + p * 0.18 && this.lives < MAX_LIVES) kind = "heart";

    const emoji =
      kind === "bomb" ? "💣" : kind === "gold" ? "⭐" : kind === "heart" ? "❤️" : FOODS[(Math.random() * FOODS.length) | 0];

    // Pick where it should peak, then solve for the launch velocity that gets
    // it there: v = sqrt(2·g·height). Peaks land in the top ~half of the
    // screen so they pass through where your face is.
    const g = this.h * 0.9;
    const x0 = this.w * (0.1 + Math.random() * 0.8);
    const y0 = this.h + 60;
    const apexY = this.h * (0.08 + Math.random() * 0.4);
    const vy = -Math.sqrt(2 * g * (y0 - apexY));
    const towardCenter = (this.w / 2 - x0) / this.w;
    const vx = (towardCenter * 0.6 + (Math.random() - 0.5) * 0.3) * this.w * 0.6;
    const r = Math.min(this.w, this.h) * (kind === "gold" ? 0.05 : 0.055);

    this.items.push({ kind, emoji, x: x0, y: y0, vx, vy, r, rot: 0, vr: (Math.random() - 0.5) * 6, dead: false });
  }

  private eat(it: Item) {
    it.dead = true;
    this.chompAnim = 1;
    this.onEat?.(it.kind);

    if (it.kind === "bomb") {
      this.lives--;
      this.combo = 0;
      this.shake = 28;
      this.flash = 1;
      this.flashColor = "255,40,40";
      this.burst(it.x, it.y, 40, ["#ff3b3b", "#ffa53b", "#333", "#fff"], 1.6);
      this.text(it.x, it.y, "BOOM", "#ff4040", 72);
      sfx.boom();
      return;
    }
    if (it.kind === "heart") {
      this.lives = Math.min(MAX_LIVES, this.lives + 1);
      this.burst(it.x, it.y, 18, ["#ff5c8a", "#fff"]);
      this.text(it.x, it.y, "+1 ❤️", "#ff5c8a", 44);
      sfx.heart();
      return;
    }

    this.combo++;
    this.eaten++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const base = it.kind === "gold" ? 500 : 100;
    const pts = base * this.multiplier;
    this.score += pts;

    if (it.kind === "gold") {
      this.slowmo = 0.9;
      this.flash = 0.6;
      this.flashColor = "255,220,80";
      this.shake = 10;
      this.burst(it.x, it.y, 36, ["#ffd93d", "#fff6a0", "#ffffff"], 1.3);
      this.text(it.x, it.y, `+${pts}`, "#ffd93d", 64);
      sfx.gold();
    } else {
      this.shake = 5;
      this.burst(it.x, it.y, 14, FOOD_COLORS);
      this.text(it.x, it.y, `+${pts}`, "#fff", 40);
      sfx.chomp(this.combo);
    }
    if (this.combo > 0 && this.combo % 5 === 0) {
      this.text(this.w / 2, this.h * 0.35, `COMBO x${this.multiplier}!`, "#7cf5ff", 84);
    }
  }

  private burst(x: number, y: number, n: number, colors: string[], power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (150 + Math.random() * 450) * power;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 150,
        life: 0.5 + Math.random() * 0.5,
        max: 1,
        color: colors[(Math.random() * colors.length) | 0],
        size: 4 + Math.random() * 8,
      });
    }
  }

  private text(x: number, y: number, text: string, color: string, size: number) {
    this.texts.push({ x, y, text, color, life: 1, size });
  }

  draw(ctx: CanvasRenderingContext2D, mouth: Mouth) {
    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);

    // Mouth reticle: a ring at your mouth that turns green and pulses when open.
    if (mouth.found && !this.over) {
      const pulse = 1 + this.chompAnim * 0.35;
      ctx.lineWidth = 5;
      ctx.strokeStyle = mouth.open ? "rgba(90,255,140,0.95)" : "rgba(255,255,255,0.55)";
      ctx.setLineDash(mouth.open ? [] : [10, 10]);
      ctx.beginPath();
      ctx.arc(mouth.x, mouth.y, mouth.reach * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (mouth.open) {
        ctx.fillStyle = "rgba(90,255,140,0.12)";
        ctx.fill();
      }
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const it of this.items) {
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(it.rot);
      if (it.kind === "gold") {
        ctx.shadowColor = "#ffd93d";
        ctx.shadowBlur = 30;
      } else if (it.kind === "bomb") {
        ctx.shadowColor = "#ff3030";
        ctx.shadowBlur = 18;
      }
      ctx.font = `${it.r * 2}px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
      ctx.fillText(it.emoji, 0, 0);
      ctx.restore();
    }

    for (const p of this.particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `900 ${t.size * (1 + (1 - t.life) * 0.2)}px "Rubik", system-ui, sans-serif`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(${this.flashColor},${this.flash * 0.35})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    this.drawHud(ctx);
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 28;
    ctx.textBaseline = "top";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";

    ctx.textAlign = "left";
    ctx.font = `900 56px "Rubik", system-ui, sans-serif`;
    ctx.strokeText(this.score.toLocaleString(), pad, pad);
    ctx.fillStyle = "#fff";
    ctx.fillText(this.score.toLocaleString(), pad, pad);
    if (this.combo >= 2) {
      ctx.font = `800 30px "Rubik", system-ui, sans-serif`;
      const c = `${this.combo} combo · x${this.multiplier}`;
      ctx.strokeText(c, pad, pad + 64);
      ctx.fillStyle = "#7cf5ff";
      ctx.fillText(c, pad, pad + 64);
    }

    ctx.textAlign = "center";
    ctx.font = `900 56px "Rubik", system-ui, sans-serif`;
    const secs = Math.ceil(this.timeLeft).toString();
    ctx.strokeText(secs, this.w / 2, pad);
    ctx.fillStyle = this.timeLeft < 10 ? "#ff6b6b" : "#fff";
    ctx.fillText(secs, this.w / 2, pad);

    ctx.textAlign = "right";
    ctx.font = `44px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
    ctx.fillText("❤️".repeat(Math.max(0, this.lives)), this.w - pad, pad + 4);
  }
}
