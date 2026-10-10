// Emoji drawn straight onto a busy webcam background get lost. Instead we
// render each emoji once into an offscreen canvas as a "sticker": a thick
// white outline, a dark drop shadow, then the emoji on top. After that,
// drawing an item is a single cheap drawImage of the cached sprite.
const cache = new Map<string, HTMLCanvasElement>();
const FONT = `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;

export function sticker(emoji: string, size: number, outline = "#ffffff"): HTMLCanvasElement {
  size = Math.round(size);
  const key = `${emoji}|${size}|${outline}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const border = Math.max(3, size * 0.07);
  const pad = Math.ceil(border * 2 + size * 0.15);
  const dim = size + pad * 2;
  const c = document.createElement("canvas");
  c.width = c.height = dim;
  const ctx = c.getContext("2d")!;

  // 1. The emoji's silhouette in the outline colour: draw the emoji, then
  //    "source-in" keeps only the pixels it covered and paints them white.
  const sil = document.createElement("canvas");
  sil.width = sil.height = dim;
  const sctx = sil.getContext("2d")!;
  sctx.font = `${size}px ${FONT}`;
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.fillText(emoji, dim / 2, dim / 2 + size * 0.06);
  sctx.globalCompositeOperation = "source-in";
  sctx.fillStyle = outline;
  sctx.fillRect(0, 0, dim, dim);

  // 2. Stamp that silhouette in a ring of offsets = a thick outline, with a
  //    drop shadow under it so it lifts off the video.
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = border * 2;
  ctx.shadowOffsetY = border;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    ctx.drawImage(sil, Math.cos(a) * border, Math.sin(a) * border);
  }
  ctx.shadowColor = "transparent";

  // 3. The real emoji on top.
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, dim / 2, dim / 2 + size * 0.06);

  cache.set(key, c);
  return c;
}
