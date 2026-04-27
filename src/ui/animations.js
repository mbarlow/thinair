// QR-shatter animations and crossfades.
//
// Public API:
//   shatterQR(host, options) -> Promise<void>
//      Splits whatever was rendered inside `host` into a grid of tiles and
//      animates them out using a random style. Resolves when the animation
//      finishes; `host` is left empty.
//   crossfadeIn(node, opts) -> Promise<void>
//      Fades + scales `node` into view from a small initial offset.

const STYLES = ["scatter", "explode", "shake", "dissolve", "fade"];

export function pickStyle() {
  return STYLES[Math.floor(Math.random() * STYLES.length)];
}

// Take any DOM node containing a single canvas (or descendant canvas) and
// shatter it into a tile grid that animates out.
export async function shatterQR(host, opts = {}) {
  const cols = opts.cols || 14;
  const rows = opts.rows || 14;
  const style = opts.style || pickStyle();
  const canvas = host.querySelector("canvas");
  if (!canvas) {
    host.innerHTML = "";
    return;
  }
  const dataURL = canvas.toDataURL("image/png");
  const w = host.clientWidth || canvas.width;
  const h = host.clientHeight || canvas.height;
  // Create a tile container the same size; replace original content.
  host.innerHTML = "";
  host.style.position = host.style.position || "relative";
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.inset = "0";
  container.style.pointerEvents = "none";
  host.appendChild(container);

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
      t.style.transition = "transform 600ms cubic-bezier(.2,.7,.2,1), opacity 600ms ease, filter 600ms ease";
      container.appendChild(t);
      tiles.push({ t, c, r });
    }
  }

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  if (style === "scatter") {
    for (const { t } of tiles) {
      const dx = (Math.random() - 0.5) * w * 1.6;
      const dy = (Math.random() - 0.5) * h * 1.6;
      const rot = (Math.random() - 0.5) * 240;
      t.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      t.style.opacity = "0";
    }
  } else if (style === "explode") {
    for (const { t, c, r } of tiles) {
      const cx = (c - cols / 2 + 0.5) * tileW;
      const cy = (r - rows / 2 + 0.5) * tileH;
      const len = Math.hypot(cx, cy) || 1;
      const dx = (cx / len) * w * 1.2;
      const dy = (cy / len) * h * 1.2;
      t.style.transform = `translate(${dx}px, ${dy}px) scale(0.6) rotate(${(c + r) * 18}deg)`;
      t.style.opacity = "0";
    }
  } else if (style === "shake") {
    for (const { t } of tiles) {
      const sx = (Math.random() - 0.5) * 12;
      const sy = (Math.random() - 0.5) * 12;
      t.style.transform = `translate(${sx}px, ${sy}px)`;
    }
    await new Promise((r) => setTimeout(r, 120));
    for (const { t } of tiles) {
      t.style.transform = "scale(1.05)";
      t.style.opacity = "0";
    }
  } else if (style === "dissolve") {
    for (const { t } of tiles) {
      t.style.transition += ", filter 600ms ease";
      t.style.filter = "blur(8px)";
      t.style.opacity = "0";
    }
  } else { // fade
    for (const { t } of tiles) {
      const dy = (Math.random() - 0.5) * 24;
      t.style.transform = `translateY(${dy}px) scale(0.9)`;
      t.style.opacity = "0";
    }
  }

  await new Promise((r) => setTimeout(r, 640));
  host.innerHTML = "";
  host.style.position = "";
}

export async function crossfadeIn(node, opts = {}) {
  const dur = opts.duration || 320;
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
  const dur = opts.duration || 280;
  node.style.transition = `opacity ${dur}ms ease, transform ${dur}ms ease`;
  node.style.opacity = "0";
  node.style.transform = opts.to || "translateY(-8px) scale(0.98)";
  await new Promise((r) => setTimeout(r, dur));
}
