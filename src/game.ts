// Core gameplay: items get tossed up from below the screen in arcs (Fruit
// Ninja style), and players eat them by opening their mouths when one is
// close. 1–4 players share the screen; each has their own score and lives.
// Everything here is in canvas pixels; `dt` is seconds since the last frame.
import { sfx } from "./audio";
import { sticker } from "./sticker";
import type { Mouth } from "./tracks";

type Kind = "food" | "gold" | "bomb" | "heart" | "chili" | "magnet";

export interface Player {
  id: number; // 1-based, left to right at game start
  trackId: number; // which face track controls this player
  color: string;
  mouth: Mouth;
  score: number;
  combo: number;
  bestCombo: number;
  eaten: number;
  lives: number;
  fever: number; // seconds of 🌶️ double points left
  magnet: number; // seconds of 🧲 food attraction left
  chompAnim: number;
  out: boolean;
}

export const PLAYER_COLORS = ["#5aff8c", "#ff5cc8", "#5cc8ff", "#ffb347"];

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
const EMOJI: Record<Exclude<Kind, "food">, string> = { gold: "⭐", bomb: "💣", heart: "❤️", chili: "🌶️", magnet: "🧲" };
export const ROUND_SECONDS = 60;
const FEAST_SECONDS = 8; // the last N seconds are a bomb-free food frenzy
const POWER_SECONDS = 6;
const MAGNET_RANGE = 320;
const MAX_LIVES = 5;

export class Game {
  items: Item[] = [];
  particles: Particle[] = [];
  texts: FloatText[] = [];
  timeLeft = ROUND_SECONDS;
  over = false;

  private spawnTimer = 0.8;
  private shake = 0;
  private flash = 0;
  private flashColor = "255,255,255";
  private slowmo = 0; // seconds of slow motion remaining
  private feastAnnounced = false;
  /** Called on every successful eat so main.ts can grab a photo of that face. */
  onEat?: (p: Player, kind: Kind) => void;

  constructor(
    public w: number,
    public h: number,
    public players: Player[],
  ) {}

  /** 0 at the start of the round, 1 at the end. Drives difficulty. */
  get progress() {
    return 1 - this.timeLeft / ROUND_SECONDS;
  }
  get feast() {
    return this.timeLeft <= FEAST_SECONDS;
  }
  get multi() {
    return this.players.length > 1;
  }
  /** Player with the strictly highest score, or undefined on a tie. */
  get leader() {
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    return sorted[0].score > 0 && (sorted.length === 1 || sorted[0].score > sorted[1].score) ? sorted[0] : undefined;
  }

  static multiplier(p: Player) {
    return Math.min(8, 1 + Math.floor(p.combo / 5)); // capped so one long streak doesn't dwarf everything
  }

  update(rawDt: number) {
    // Slow-mo scales world time (the round timer included, so ⭐ buys time).
    const dt = rawDt * (this.slowmo > 0 ? 0.35 : 1);
    this.slowmo = Math.max(0, this.slowmo - rawDt);
    this.shake = Math.max(0, this.shake - rawDt * 30);
    this.flash = Math.max(0, this.flash - rawDt * 3);
    for (const p of this.players) {
      p.chompAnim = Math.max(0, p.chompAnim - rawDt * 5);
      p.fever = Math.max(0, p.fever - dt);
      p.magnet = Math.max(0, p.magnet - dt);
    }

    if (!this.over) {
      this.timeLeft -= dt;
      if (this.feast && !this.feastAnnounced) {
        this.feastAnnounced = true;
        this.text(this.w / 2, this.h * 0.4, "🍽️ FEAST MODE!", "#ffd93d", 96, 2);
        sfx.gold();
      }
      if (this.timeLeft <= 0 || this.players.every((p) => p.out)) {
        this.timeLeft = Math.max(0, this.timeLeft);
        this.over = true;
        sfx.over();
      }
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) this.spawnWave();
    }

    const g = this.h * 0.9; // gravity, px/s²
    const live = this.players.filter((p) => !p.out && p.mouth.found);
    for (const it of this.items) {
      // 🧲 Magnet: pull nearby food toward the magnet player's mouth.
      if (it.kind !== "bomb") {
        for (const p of live) {
          if (p.magnet <= 0) continue;
          const dx = p.mouth.x - it.x;
          const dy = p.mouth.y - it.y;
          const d = Math.hypot(dx, dy);
          if (d < MAGNET_RANGE && d > 1) {
            it.vx += (dx / d) * 2600 * dt;
            it.vy += (dy / d) * 2600 * dt - g * dt * 0.8; // mostly cancel gravity while caught
            it.vx *= 0.96;
            it.vy *= 0.96;
          }
        }
      }
      it.vy += g * dt;
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.rot += it.vr * dt;

      if (!this.over && !it.dead) {
        // Closest open mouth in range gets it.
        let best: Player | undefined;
        let bestD = Infinity;
        for (const p of live) {
          if (!p.mouth.open) continue;
          const d = Math.hypot(it.x - p.mouth.x, it.y - p.mouth.y);
          if (d < p.mouth.reach + it.r * 0.6 && d < bestD) {
            best = p;
            bestD = d;
          }
        }
        if (best) this.eat(best, it);
      }
      // Fell off the bottom: missed food breaks the combo of the player
      // closest to it (whoever "should" have got it), not everyone's.
      if (!it.dead && it.vy > 0 && it.y > this.h + it.r * 2) {
        it.dead = true;
        if ((it.kind === "food" || it.kind === "gold") && !this.over && live.length) {
          const p = live.reduce((a, b) => (Math.abs(a.mouth.x - it.x) < Math.abs(b.mouth.x - it.x) ? a : b));
          if (p.combo >= 3) this.text(it.x, this.h - 60, "combo lost", "#aaa", 28);
          p.combo = 0;
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
    if (this.feast) {
      for (let i = 0; i < 2; i++) this.spawn("food");
      this.spawnTimer = 0.2;
      return;
    }
    // Waves get bigger and faster as the round goes on, and with more players.
    const extra = this.players.length - 1;
    const count = 1 + (Math.random() < 0.25 + p * 0.5 ? 1 : 0) + (Math.random() < p * 0.4 + extra * 0.2 ? 1 : 0);
    for (let i = 0; i < count; i++) this.spawn();
    this.spawnTimer = (1.0 - p * 0.55 + Math.random() * 0.3) / (1 + extra * 0.35);
  }

  private spawn(force?: Kind) {
    const p = this.progress;
    let kind: Kind = force ?? "food";
    if (!force) {
      const r = Math.random();
      const bomb = 0.1 + p * 0.18;
      const lowLives = this.players.some((pl) => !pl.out && pl.lives < MAX_LIVES);
      if (r < bomb) kind = "bomb";
      else if (r < bomb + 0.06) kind = "gold";
      else if (r < bomb + 0.095) kind = "chili";
      else if (r < bomb + 0.13) kind = "magnet";
      else if (r < bomb + 0.145 && lowLives) kind = "heart";
    }
    if (this.feast && kind === "bomb") kind = "food";
    const emoji = kind === "food" ? FOODS[(Math.random() * FOODS.length) | 0] : EMOJI[kind];

    // Pick where it should peak, then solve for the launch velocity that gets
    // it there: v = sqrt(2·g·height). Peaks land in the top ~half of the
    // screen so they pass through where faces are.
    const g = this.h * 0.9;
    const x0 = this.w * (0.08 + Math.random() * 0.84);
    const y0 = this.h + 60;
    const apexY = this.h * (0.08 + Math.random() * 0.4);
    const vy = -Math.sqrt(2 * g * (y0 - apexY));
    const towardCenter = (this.w / 2 - x0) / this.w;
    const vx = (towardCenter * 0.6 + (Math.random() - 0.5) * 0.3) * this.w * 0.6;
    const r = Math.min(this.w, this.h) * 0.055;

    this.items.push({ kind, emoji, x: x0, y: y0, vx, vy, r, rot: 0, vr: (Math.random() - 0.5) * 5, dead: false });
  }

  private eat(p: Player, it: Item) {
    it.dead = true;
    p.chompAnim = 1;
    this.onEat?.(p, it.kind);

    switch (it.kind) {
      case "bomb":
        p.lives--;
        p.combo = 0;
        this.shake = 28;
        this.flash = 1;
        this.flashColor = "255,40,40";
        this.burst(it.x, it.y, 40, ["#ff3b3b", "#ffa53b", "#333", "#fff"], 1.6);
        this.text(it.x, it.y, "BOOM", "#ff4040", 72);
        sfx.boom();
        if (p.lives <= 0) {
          p.out = true;
          if (this.multi) this.text(p.mouth.x, p.mouth.y - 80, `P${p.id} is out!`, p.color, 48, 1.5);
        }
        return;
      case "heart":
        p.lives = Math.min(MAX_LIVES, p.lives + 1);
        this.burst(it.x, it.y, 18, ["#ff5c8a", "#fff"]);
        this.text(it.x, it.y, "+1 ❤️", "#ff5c8a", 44);
        sfx.heart();
        return;
      case "chili":
        p.fever = POWER_SECONDS;
        this.burst(it.x, it.y, 30, ["#ff3b1f", "#ff9a1f", "#ffd93d"], 1.2);
        this.text(it.x, it.y, "🔥 FEVER x2", "#ff7a1f", 52);
        this.shake = 10;
        sfx.gold();
        return;
      case "magnet":
        p.magnet = POWER_SECONDS;
        this.burst(it.x, it.y, 24, ["#5cc8ff", "#ff5c5c", "#fff"]);
        this.text(it.x, it.y, "🧲 MAGNET", "#5cc8ff", 52);
        sfx.heart();
        return;
    }

    p.combo++;
    p.eaten++;
    p.bestCombo = Math.max(p.bestCombo, p.combo);
    const mult = Game.multiplier(p) * (p.fever > 0 ? 2 : 1);
    const pts = (it.kind === "gold" ? 500 : 100) * mult;
    p.score += pts;

    if (it.kind === "gold") {
      this.slowmo = 0.9;
      this.flash = 0.6;
      this.flashColor = "255,220,80";
      this.shake = 10;
      this.burst(it.x, it.y, 36, ["#ffd93d", "#fff6a0", "#ffffff"], 1.3);
      this.text(it.x, it.y, `+${pts}`, "#ffd93d", 64);
      sfx.gold();
    } else {
      this.shake = Math.max(this.shake, 5);
      this.burst(it.x, it.y, 14, p.fever > 0 ? ["#ff3b1f", "#ff9a1f", "#ffd93d"] : FOOD_COLORS);
      this.text(it.x, it.y, `+${pts}`, this.multi ? p.color : "#fff", 40);
      sfx.chomp(p.combo);
    }
    if (p.combo % 5 === 0 && p.combo <= 35) {
      const who = this.multi ? `P${p.id} ` : "";
      this.text(this.w / 2, this.h * 0.35, `${who}COMBO x${Game.multiplier(p)}!`, this.multi ? p.color : "#7cf5ff", 80);
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
        color: colors[(Math.random() * colors.length) | 0],
        size: 4 + Math.random() * 8,
      });
    }
  }

  private text(x: number, y: number, text: string, color: string, size: number, life = 1) {
    this.texts.push({ x, y, text, color, life, size });
  }

  draw(ctx: CanvasRenderingContext2D, now: number) {
    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);

    for (const p of this.players) if (!this.over) this.drawPlayer(ctx, p, now);

    const leader = this.multi ? this.leader : undefined;
    if (leader?.mouth.found) {
      // 👑 on the leader's head, bobbing slightly.
      const m = leader.mouth;
      const s = sticker("👑", Math.max(40, m.headSize * 0.5));
      const bob = Math.sin(now / 200) * 4;
      ctx.drawImage(s, m.headX - s.width / 2, m.headY - s.height * 0.85 + bob);
    }

    for (const it of this.items) {
      const s = sticker(it.emoji, it.r * 2);
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(it.rot);
      if (it.kind === "gold" || it.kind === "chili" || it.kind === "magnet") {
        // Power-ups get a pulsing halo so they read as special.
        const glow = it.kind === "gold" ? "255,217,61" : it.kind === "chili" ? "255,90,30" : "92,200,255";
        const pr = it.r * (1.3 + Math.sin(now / 120) * 0.12);
        const grad = ctx.createRadialGradient(0, 0, it.r * 0.5, 0, 0, pr);
        grad.addColorStop(0, `rgba(${glow},0.65)`);
        grad.addColorStop(1, `rgba(${glow},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.drawImage(s, -s.width / 2, -s.height / 2);
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

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const t of this.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.font = `900 ${t.size * (1 + Math.max(0, 1 - t.life) * 0.2)}px "Rubik", system-ui, sans-serif`;
      ctx.lineWidth = 7;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
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
    if (this.feast && !this.over) {
      // Warm pulsing border during the finale.
      ctx.lineWidth = 16;
      ctx.strokeStyle = `rgba(255,200,60,${0.4 + Math.sin(now / 100) * 0.25})`;
      ctx.strokeRect(0, 0, this.w, this.h);
    }

    this.drawHud(ctx);
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, p: Player, now: number) {
    const m = p.mouth;
    if (!m.found) return;
    if (p.out) {
      ctx.font = `48px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("💀", m.x, m.y);
      return;
    }
    const color = this.multi ? p.color : "#5aff8c";
    if (p.magnet > 0) {
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(92,200,255,0.5)";
      ctx.setLineDash([14, 12]);
      ctx.lineDashOffset = -now / 20;
      ctx.beginPath();
      ctx.arc(m.x, m.y, MAGNET_RANGE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (p.fever > 0) {
      ctx.save();
      ctx.shadowColor = "#ff5a1e";
      ctx.shadowBlur = 40;
      ctx.lineWidth = 10;
      ctx.strokeStyle = `rgba(255,${120 + Math.sin(now / 60) * 60},30,0.9)`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.reach + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Mouth reticle: solid + filled when open, dashed when closed.
    const pulse = 1 + p.chompAnim * 0.35;
    ctx.lineWidth = 5;
    ctx.strokeStyle = m.open ? color : "rgba(255,255,255,0.6)";
    ctx.setLineDash(m.open ? [] : [10, 10]);
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.reach * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.open) {
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (this.multi) {
      ctx.font = `900 28px "Rubik", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.strokeText(`P${p.id}`, m.x, m.y + m.reach + 26);
      ctx.fillStyle = p.color;
      ctx.fillText(`P${p.id}`, m.x, m.y + m.reach + 26);
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 28;
    ctx.textBaseline = "top";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    const big = !this.multi;

    this.players.forEach((p, i) => {
      const y = pad + i * 58;
      let x = pad;
      ctx.textAlign = "left";
      ctx.globalAlpha = p.out ? 0.45 : 1;
      if (this.multi) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x + 14, y + 22, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `900 18px "Rubik", system-ui, sans-serif`;
        ctx.fillStyle = "#0d0b1e";
        ctx.textAlign = "center";
        ctx.fillText(String(p.id), x + 14, y + 13);
        ctx.textAlign = "left";
        x += 40;
      }
      ctx.font = `900 ${big ? 56 : 40}px "Rubik", system-ui, sans-serif`;
      const score = p.score.toLocaleString();
      ctx.strokeText(score, x, y);
      ctx.fillStyle = "#fff";
      ctx.fillText(score, x, y);
      x += ctx.measureText(score).width + 16;

      if (!big) {
        ctx.font = `24px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
        ctx.fillText("❤️".repeat(Math.max(0, p.lives)), x, y + 8);
        x += ctx.measureText("❤️".repeat(Math.max(0, p.lives))).width + 12;
      }
      const tags = [
        p.combo >= 2 ? `x${Game.multiplier(p) * (p.fever > 0 ? 2 : 1)}` : "",
        p.fever > 0 ? `🌶️${Math.ceil(p.fever)}` : "",
        p.magnet > 0 ? `🧲${Math.ceil(p.magnet)}` : "",
      ].filter(Boolean);
      if (tags.length) {
        ctx.font = `800 ${big ? 30 : 24}px "Rubik", system-ui, sans-serif`;
        const ty = big ? y + 64 : y + 8;
        const tx = big ? pad : x;
        ctx.strokeText(tags.join("  "), tx, ty);
        ctx.fillStyle = p.fever > 0 ? "#ff9a1f" : "#7cf5ff";
        ctx.fillText(tags.join("  "), tx, ty);
      }
      ctx.globalAlpha = 1;
    });

    ctx.textAlign = "center";
    ctx.font = `900 56px "Rubik", system-ui, sans-serif`;
    const secs = Math.ceil(this.timeLeft).toString();
    ctx.strokeText(secs, this.w / 2, pad);
    ctx.fillStyle = this.feast ? "#ffd93d" : this.timeLeft < 10 ? "#ff6b6b" : "#fff";
    ctx.fillText(secs, this.w / 2, pad);

    if (big) {
      ctx.textAlign = "right";
      ctx.font = `44px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
      ctx.fillText("❤️".repeat(Math.max(0, this.players[0].lives)), this.w - pad, pad + 4);
    }
  }
}
