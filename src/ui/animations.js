// QR-shatter animations and crossfades.
//
// shatterQR(host) lifts the rendered QR canvas onto a fixed-position overlay
// at the top of the document, splits it into a tile grid, and animates the
// tiles outward across the whole viewport. Lifting to a fixed overlay is the
// trick that lets the tiles fly outside the QR frame even when the page is
// crossfading underneath them.

const STYLES = ["scatter", "explode", "shake", "dissolve", "fade"];

export function pickStyle() {
  return STYLES[Math.floor(Math.random() * STYLES.length)];
}

export async function shatterQR(host, opts = {}) {
  const cols = opts.cols || 12;
  const rows = opts.rows || 12;
  const style = opts.style || pickStyle();
  const duration = opts.duration || 520;
  const canvas = host.querySelector("canvas");
  if (!canvas) {
    host.innerHTML = "";
    return;
  }

  // Snapshot the canvas, then size + position an overlay where the QR sits.
  const dataURL = canvas.toDataURL("image/png");
  const rect = host.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Hide the original immediately so the user only sees the overlay.
  host.style.visibility = "hidden";

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.left = rect.left + "px";
  overlay.style.top = rect.top + "px";
  overlay.style.width = w + "px";
  overlay.style.height = h + "px";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "1000";
  overlay.style.willChange = "transform, opacity";
  document.body.appendChild(overlay);

  const tileW = w / cols;
  const tileH = h / rows;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = document.createElement("div");
      t.style.position = "absolute";
      t.style.left = c * tileW + "px";
      t.style.top = r * tileH + "px";
      t.style.width = tileW + "px";
      t.style.height = tileH + "px";
      t.style.backgroundImage = `url(${dataURL})`;
      t.style.backgroundSize = `${w}px ${h}px`;
      t.style.backgroundPosition = `${-c * tileW}px ${-r * tileH}px`;
      t.style.willChange = "transform, opacity, filter";
      t.style.transition =
        `transform ${duration}ms cubic-bezier(.2,.7,.2,1), ` +
        `opacity ${duration}ms ease, ` +
        `filter ${duration}ms ease`;
      overlay.appendChild(t);
      tiles.push({ t, c, r });
    }
  }

  // Force a layout flush so the initial styles are committed.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  if (style === "scatter") {
    for (const { t } of tiles) {
      const dx = (Math.random() - 0.5) * vw * 1.4;
      const dy = (Math.random() - 0.5) * vh * 1.4;
      const rot = (Math.random() - 0.5) * 720;
      t.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(0.7)`;
      t.style.opacity = "0";
    }
  } else if (style === "explode") {
    const cx = w / 2;
    const cy = h / 2;
    for (const { t, c, r } of tiles) {
      const tx = (c + 0.5) * tileW - cx;
      const ty = (r + 0.5) * tileH - cy;
      const len = Math.hypot(tx, ty) || 1;
      const dx = (tx / len) * Math.max(vw, vh) * 0.9;
      const dy = (ty / len) * Math.max(vw, vh) * 0.9;
      t.style.transform = `translate(${dx}px, ${dy}px) scale(0.4) rotate(${(c + r) * 24}deg)`;
      t.style.opacity = "0";
    }
  } else if (style === "shake") {
    for (const { t } of tiles) {
      const sx = (Math.random() - 0.5) * 18;
      const sy = (Math.random() - 0.5) * 18;
      t.style.transform = `translate(${sx}px, ${sy}px)`;
    }
    await new Promise((r) => setTimeout(r, 120));
    for (const { t } of tiles) {
      const dy = (Math.random() - 0.4) * h * 1.5;
      const dx = (Math.random() - 0.5) * w * 1.2;
      t.style.transform = `translate(${dx}px, ${dy}px) scale(0.6) rotate(${(Math.random() - 0.5) * 540}deg)`;
      t.style.opacity = "0";
    }
  } else if (style === "dissolve") {
    for (const { t } of tiles) {
      const dx = (Math.random() - 0.5) * 40;
      const dy = (Math.random() - 0.5) * 40;
      t.style.filter = "blur(14px)";
      t.style.transform = `translate(${dx}px, ${dy}px) scale(1.1)`;
      t.style.opacity = "0";
    }
  } else { // fade
    for (const { t } of tiles) {
      const dy = (Math.random() - 0.3) * 80;
      const dx = (Math.random() - 0.5) * 80;
      t.style.transform = `translate(${dx}px, ${dy}px) scale(0.9)`;
      t.style.opacity = "0";
    }
  }

  await new Promise((r) => setTimeout(r, duration + 40));
  overlay.remove();
  host.innerHTML = "";
  host.style.visibility = "";
}

export async function crossfadeIn(node, opts = {}) {
  const dur = opts.duration || 280;
  node.style.transition = `opacity ${dur}ms ease, transform ${dur}ms cubic-bezier(.2,.7,.2,1)`;
  node.style.opacity = "0";
  node.style.transform = opts.from || "translateY(8px) scale(0.98)";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  node.style.opacity = "1";
  node.style.transform = "translateY(0) scale(1)";
  await new Promise((r) => setTimeout(r, dur));
  node.style.transition = "";
}

export async function crossfadeOut(node, opts = {}) {
  const dur = opts.duration || 220;
  node.style.transition = `opacity ${dur}ms ease, transform ${dur}ms ease`;
  node.style.opacity = "0";
  node.style.transform = opts.to || "translateY(-6px) scale(0.98)";
  await new Promise((r) => setTimeout(r, dur));
}
