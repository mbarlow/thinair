export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const k of Object.keys(attrs)) {
    if (k === "class") e.className = attrs[k];
    else if (k.startsWith("on") && typeof attrs[k] === "function") {
      e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    } else if (k === "style" && typeof attrs[k] === "object") {
      Object.assign(e.style, attrs[k]);
    } else if (k in e && typeof attrs[k] !== "string") {
      try { e[k] = attrs[k]; } catch { e.setAttribute(k, attrs[k]); }
    } else {
      e.setAttribute(k, attrs[k]);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toString() : n.toFixed(1)) + " " + u[i];
}

export function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } finally { ta.remove(); }
  return Promise.resolve();
}

export function toast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.position = "fixed";
  t.style.bottom = "60px";
  t.style.left = "50%";
  t.style.transform = "translateX(-50%)";
  t.style.background = "#0e1014";
  t.style.color = "#e8eaee";
  t.style.padding = "10px 14px";
  t.style.border = "1px solid #1f242c";
  t.style.borderRadius = "8px";
  t.style.zIndex = "100";
  t.style.fontSize = "13px";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

export function logger(node) {
  return (msg) => {
    const ts = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.innerHTML = `<span class="ts">${ts}</span> ${escapeHtml(String(msg))}`;
    node.appendChild(line);
    node.scrollTop = node.scrollHeight;
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
