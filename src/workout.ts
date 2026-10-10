// Jaw Workout: the same face tracking, turned into a guided exercise.
// Jaw-opening ("range of motion") exercises are prescribed for things like TMJ
// stiffness, trismus after head-and-neck radiation, and facial weakness after
// a stroke. The hard part is doing the boring reps every day. Here each rep is
// a game beat: line your mouth up with a snack, open wide past your target,
// and hold until the ring fills. The target adapts to your own range, and
// every session is logged so you can watch your progress.
import { sfx } from "./audio";
import { sticker } from "./sticker";
import type { Mouth } from "./tracks";

export interface WorkoutResult {
  date: string; // ISO
  reps: number;
  avgOpen: number; // mean peak jawOpen per rep, 0..1
  bestOpen: number;
  secs: number;
}

const SNACKS = ["🍎", "🥕", "🥦", "🍇", "🍐", "🥝", "🍊", "🫐"];
export const WORKOUT_REPS = 10;
const HOLD_SECS = 1.5;
const REST_SECS = 1.2;

export class Workout {
  reps = 0;
  peaks: number[] = [];
  elapsed = 0;
  done = false;
  threshold = 0.4; // jawOpen needed to count; adapts after each rep
  private hold = 0;
  private peak = 0;
  private rest = 0.6;
  private target = { x: 0, y: 0, emoji: "🍎" };
  private burstT = 0;
  private burstAt = { x: 0, y: 0 };

  constructor(
    public w: number,
    public h: number,
  ) {
    this.placeTarget();
  }

  private placeTarget() {
    // Small hops around the middle of the screen: you shouldn't have to
    // crane your neck, just a gentle head turn between reps.
    const spots = [
      [0, 0],
      [-0.16, 0],
      [0.16, 0],
      [-0.1, -0.1],
      [0.1, -0.1],
    ];
    const [dx, dy] = spots[this.reps % spots.length];
    this.target = {
      x: this.w * (0.5 + dx),
      y: this.h * (0.58 + dy),
      emoji: SNACKS[this.reps % SNACKS.length],
    };
  }

  private get radius() {
    return Math.min(this.w, this.h) * 0.075;
  }

  update(dt: number, m: Mouth) {
    if (this.done) return;
    this.elapsed += dt;
    this.burstT = Math.max(0, this.burstT - dt);
    if (this.rest > 0) {
      this.rest -= dt;
      return;
    }

    const lined = m.found && Math.hypot(m.x - this.target.x, m.y - this.target.y) < m.reach + this.radius;
    if (lined && m.jaw >= this.threshold) {
      this.hold += dt;
      this.peak = Math.max(this.peak, m.jaw);
    } else {
      this.hold = Math.max(0, this.hold - dt * 2); // drain, don't reset: forgiving
    }

    if (this.hold >= HOLD_SECS) {
      this.reps++;
      this.peaks.push(this.peak);
      sfx.chomp(this.reps);
      if (this.reps % 5 === 0) sfx.gold();
      this.burstAt = { ...this.target };
      this.burstT = 0.6;
      this.hold = 0;
      this.peak = 0;
      // Adapt: aim for ~70% of your average peak so far, so the target tracks
      // your range but stays holdable for 1.5 s.
      const avg = this.peaks.reduce((a, b) => a + b, 0) / this.peaks.length;
      this.threshold = Math.min(0.55, Math.max(0.3, avg * 0.7));
      if (this.reps >= WORKOUT_REPS) {
        this.done = true;
        sfx.over();
      } else {
        this.rest = REST_SECS;
        this.placeTarget();
      }
    }
  }

  result(): WorkoutResult {
    const n = this.peaks.length || 1;
    return {
      date: new Date().toISOString(),
      reps: this.reps,
      avgOpen: this.peaks.reduce((a, b) => a + b, 0) / n,
      bestOpen: Math.max(0, ...this.peaks),
      secs: Math.round(this.elapsed),
    };
  }

  draw(ctx: CanvasRenderingContext2D, m: Mouth, now: number) {
    const { x, y } = this.target;
    const R = this.radius;
    const resting = this.rest > 0;

    // Rep counter as a row of dots.
    const dotGap = 34;
    const startX = this.w / 2 - ((WORKOUT_REPS - 1) * dotGap) / 2;
    for (let i = 0; i < WORKOUT_REPS; i++) {
      ctx.beginPath();
      ctx.arc(startX + i * dotGap, 48, 11, 0, Math.PI * 2);
      ctx.fillStyle = i < this.reps ? "#5aff8c" : "rgba(255,255,255,0.25)";
      ctx.fill();
    }

    // Prompt line.
    let prompt = "line your mouth up with the snack";
    if (resting) prompt = this.reps === 0 ? "get ready…" : "nice! relax 😌";
    else if (this.hold > 0) prompt = "hold it… 😮";
    else if (m.found && Math.hypot(m.x - x, m.y - y) < m.reach + R) prompt = "now open wide!";
    if (!m.found) prompt = "can't see your face 👀";
    this.label(ctx, prompt, this.w / 2, 100, 34, "#fff");

    // Celebration burst on the last completed rep.
    if (this.burstT > 0) {
      const t = 1 - this.burstT / 0.6;
      ctx.strokeStyle = `rgba(90,255,140,${1 - t})`;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(this.burstAt.x, this.burstAt.y, R * (1 + t * 2), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (!resting) {
      // Target snack with a hold ring that fills as you keep your mouth open.
      const s = sticker(this.target.emoji, R * 1.6);
      const bob = Math.sin(now / 300) * 4;
      ctx.drawImage(s, x - s.width / 2, y - s.height / 2 + bob);
      ctx.lineWidth = 10;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.arc(x, y, R + 18, 0, Math.PI * 2);
      ctx.stroke();
      if (this.hold > 0) {
        ctx.strokeStyle = "#5aff8c";
        ctx.beginPath();
        ctx.arc(x, y, R + 18, -Math.PI / 2, -Math.PI / 2 + (this.hold / HOLD_SECS) * Math.PI * 2);
        ctx.stroke();
      }
    }

    // Mouth marker.
    if (m.found) {
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.reach * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this.drawMeter(ctx, m);
  }

  /** Vertical "how open is your jaw" bar with your target line on it. */
  private drawMeter(ctx: CanvasRenderingContext2D, m: Mouth) {
    const bw = 34;
    const bh = Math.min(360, this.h * 0.5);
    const bx = this.w - 70;
    const by = this.h / 2 - bh / 2;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.roundRect(bx - 8, by - 8, bw + 16, bh + 16, 18);
    ctx.fill();

    const v = Math.min(1, m.found ? m.jaw / 0.9 : 0);
    const reached = m.jaw >= this.threshold;
    ctx.fillStyle = reached ? "#5aff8c" : "#ffd93d";
    ctx.beginPath();
    ctx.roundRect(bx, by + bh * (1 - v), bw, bh * v, 10);
    ctx.fill();

    const ty = by + bh * (1 - this.threshold / 0.9);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx - 14, ty);
    ctx.lineTo(bx + bw + 6, ty);
    ctx.stroke();
    ctx.textAlign = "right";
    this.label(ctx, "target", bx - 18, ty, 20, "#fff", "right");
    this.label(ctx, `${Math.round(m.jaw * 100)}%`, bx + bw / 2, by + bh + 34, 24, "#fff");
  }

  private label(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "center") {
    ctx.font = `800 ${size}px "Rubik", system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
}
