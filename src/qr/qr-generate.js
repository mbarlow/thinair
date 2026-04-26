// QR generation via qrcode-generator (window.qrcode).
// Renders to a Canvas. Falls back to animated multi-frame QR for large payloads.

function getQR() {
  if (typeof window !== "undefined" && typeof window.qrcode === "function") return window.qrcode;
  throw new Error("qrcode-generator not loaded");
}

// Ranges (max byte capacity per level for version 40):
// L: 2953, M: 2331, Q: 1663, H: 1273
// We aim for "M" but auto-bump to L for big payloads. Beyond ~2900 bytes, animate.
const SOFT_LIMIT_M = 2300;
const HARD_LIMIT = 2900;

function renderToCanvas(canvas, text, size, level) {
  const qr = getQR()(0, level);
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const margin = 4;
  const total = modules + margin * 2;
  const px = Math.max(1, Math.floor(size / total));
  const w = px * total;
  canvas.width = w;
  canvas.height = w;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, w);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + margin) * px, (r + margin) * px, px, px);
      }
    }
  }
}

export async function renderQR(target, text, opts = {}) {
  target.innerHTML = "";
  const canvas = document.createElement("canvas");
  target.appendChild(canvas);
  const size = opts.size || Math.min(360, Math.max(240, Math.floor(target.clientWidth || 320)));
  let level = opts.ecc || (text.length > SOFT_LIMIT_M ? "L" : "M");
  try {
    renderToCanvas(canvas, text, size, level);
  } catch (e) {
    // Fall back to L for capacity errors
    if (level !== "L") {
      try { renderToCanvas(canvas, text, size, "L"); return; } catch {}
    }
    throw e;
  }
}

export class AnimatedQR {
  constructor(target, fullText, opts = {}) {
    this.target = target;
    this.opts = opts;
    this.frames = AnimatedQR.frame(fullText, opts.maxChunk || HARD_LIMIT - 100);
    this.idx = 0;
    this.timer = null;
    this.intervalMs = opts.intervalMs || 350;
  }

  static frame(text, maxChunk) {
    if (text.length <= maxChunk) return [text];
    const id = Math.random().toString(36).slice(2, 8);
    const total = Math.ceil(text.length / maxChunk);
    const out = [];
    for (let i = 0; i < total; i++) {
      const slice = text.slice(i * maxChunk, (i + 1) * maxChunk);
      out.push(`thinair-frag:1:${id}:${i + 1}/${total}:${slice}`);
    }
    return out;
  }

  async start() {
    if (this.frames.length === 1) {
      await renderQR(this.target, this.frames[0], this.opts);
      return;
    }
    const tick = async () => {
      const f = this.frames[this.idx % this.frames.length];
      try { await renderQR(this.target, f, { ...this.opts, ecc: "L" }); } catch (e) { console.error(e); }
      this.idx++;
    };
    await tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const FRAG_PREFIX = "thinair-frag:";
