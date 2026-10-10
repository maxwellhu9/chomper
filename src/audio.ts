// All sound effects are synthesized live with the Web Audio API, so there are
// no audio files to load. Each effect is an oscillator (or noise) shaped by a
// quick volume envelope.
let ctx: AudioContext | null = null;
let muted = false;

export function unlockAudio() {
  // Browsers only allow audio after a user gesture, so call this on click/key.
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
}

export function toggleMute() {
  muted = !muted;
  return muted;
}

function tone(freq: number, dur: number, type: OscillatorType, vol = 0.2, slideTo?: number, delay = 0) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function noise(dur: number, vol = 0.3, delay = 0) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = vol;
  src.buffer = buf;
  src.connect(gain).connect(ctx.destination);
  src.start(t);
}

export const sfx = {
  // Pitch climbs with combo so a streak literally sounds like it's building.
  chomp(combo: number) {
    const f = 300 * Math.pow(2, Math.min(combo, 24) / 12);
    tone(f, 0.12, "square", 0.12, f * 1.6);
    noise(0.05, 0.15);
  },
  gold() {
    [0, 4, 7, 12].forEach((semi, i) => tone(660 * Math.pow(2, semi / 12), 0.18, "triangle", 0.15, undefined, i * 0.06));
  },
  boom() {
    noise(0.6, 0.6);
    tone(120, 0.5, "sawtooth", 0.3, 30);
  },
  heart() {
    tone(523, 0.12, "sine", 0.2);
    tone(784, 0.2, "sine", 0.2, undefined, 0.1);
  },
  miss() {
    tone(220, 0.15, "sine", 0.08, 140);
  },
  tick() {
    tone(880, 0.08, "square", 0.08);
  },
  go() {
    tone(1320, 0.25, "square", 0.1);
  },
  over() {
    [0, -3, -7, -12].forEach((semi, i) => tone(440 * Math.pow(2, semi / 12), 0.3, "triangle", 0.15, undefined, i * 0.18));
  },
};
