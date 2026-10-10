// Turns per-frame face detections into stable "tracks" that keep the same id
// from frame to frame. MediaPipe gives faces back in arbitrary order, so if
// two people play we have to work out which face is which ourselves.
//
// Method: greedy nearest-neighbour matching. Measure the distance from every
// existing track to every new face, then pair up the closest ones first. A
// face that matches no track starts a new track. A track that goes unseen for
// a while is dropped. Faces don't teleport between frames, so this is enough.
import type { RawFace } from "./face";

export interface Mouth {
  x: number; // canvas px
  y: number;
  open: boolean;
  jaw: number;
  reach: number; // eat radius in px; bigger when you lean toward the camera
  found: boolean;
  headX: number; // top of head, canvas px (for the crown)
  headY: number;
  headSize: number;
}

export interface Track {
  id: number;
  face: RawFace; // smoothed, normalized
  open: boolean;
  found: boolean;
  lastSeen: number;
}

// Hysteresis: "open" needs jaw > 0.35, but stays open until jaw < 0.22.
// Without the gap, a jaw hovering around one threshold flickers open/closed.
export const JAW_OPEN = 0.35;
export const JAW_CLOSE = 0.22;
const MATCH_DIST = 0.25; // max normalized distance a face can move between frames
const FORGET_AFTER = 1500; // ms

export class Tracks {
  list: Track[] = [];
  private nextId = 1;

  update(faces: RawFace[], now: number) {
    const pairs: [number, number, number][] = [];
    this.list.forEach((t, ti) =>
      faces.forEach((f, fi) => pairs.push([Math.hypot(t.face.x - f.x, t.face.y - f.y), ti, fi])),
    );
    pairs.sort((a, b) => a[0] - b[0]);

    const usedT = new Set<number>();
    const usedF = new Set<number>();
    for (const [d, ti, fi] of pairs) {
      if (d > MATCH_DIST || usedT.has(ti) || usedF.has(fi)) continue;
      usedT.add(ti);
      usedF.add(fi);
      this.smooth(this.list[ti], faces[fi], now);
    }
    this.list.forEach((t, ti) => {
      if (!usedT.has(ti)) t.found = false;
    });
    faces.forEach((f, fi) => {
      if (!usedF.has(fi)) this.list.push({ id: this.nextId++, face: { ...f }, open: false, found: true, lastSeen: now });
    });
    this.list = this.list.filter((t) => now - t.lastSeen < FORGET_AFTER);
  }

  private smooth(t: Track, f: RawFace, now: number) {
    // Light exponential smoothing: raw landmarks jitter a few px per frame.
    // Position follows fast (stay responsive), size slowly.
    const s = t.face;
    const k = t.found ? 0.6 : 1;
    s.x += (f.x - s.x) * k;
    s.y += (f.y - s.y) * k;
    s.topX += (f.topX - s.topX) * k;
    s.topY += (f.topY - s.topY) * k;
    s.jaw += (f.jaw - s.jaw) * (t.found ? 0.5 : 1);
    s.scale += (f.scale - s.scale) * 0.2;
    s.faceH += (f.faceH - s.faceH) * 0.2;
    t.open = t.open ? s.jaw > JAW_CLOSE : s.jaw > JAW_OPEN;
    t.found = true;
    t.lastSeen = now;
  }

  get(id: number) {
    return this.list.find((t) => t.id === id);
  }
}

/** Where the mirrored video sits on screen; maps normalized coords to px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function writeMouth(t: Track | undefined, r: Rect, m: Mouth) {
  if (!t) {
    m.found = false;
    m.open = false;
    return;
  }
  const f = t.face;
  m.found = t.found;
  m.open = t.found && t.open;
  m.jaw = f.jaw;
  m.x = r.x + f.x * r.w;
  m.y = r.y + f.y * r.h;
  m.reach = Math.max(50, f.scale * r.w * 0.38);
  m.headX = r.x + f.topX * r.w;
  m.headY = r.y + f.topY * r.h;
  m.headSize = f.faceH * r.h;
}

export function newMouth(): Mouth {
  return { x: 0, y: 0, open: false, jaw: 0, reach: 70, found: false, headX: 0, headY: 0, headSize: 100 };
}
