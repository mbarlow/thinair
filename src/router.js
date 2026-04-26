// Hash-based router. Routes are: #/, #/send, #/receive, #/manual, #/audio, #/diagnostics
const handlers = {};

export function on(route, handler) {
  handlers[route] = handler;
}

export function go(route) {
  if (location.hash !== "#" + route) {
    location.hash = "#" + route;
  } else {
    dispatch();
  }
}

function dispatch() {
  const raw = (location.hash || "#/").slice(1) || "/";
  // Allow ?thinair=... hash payloads (handled separately by app.js); fall back to home.
  let route = raw;
  if (raw.startsWith("/thinair=")) route = "/";
  const fn = handlers[route] || handlers["/"];
  // Highlight nav
  for (const a of document.querySelectorAll("[data-route]")) {
    a.classList.toggle("active", "/" + a.dataset.route === route || (a.dataset.route === "home" && route === "/"));
  }
  // Tear down any previous view
  if (window._currentTeardown) {
    try { window._currentTeardown(); } catch {}
    window._currentTeardown = null;
  }
  const root = document.getElementById("app");
  if (fn) {
    const td = fn(root);
    if (typeof td === "function") window._currentTeardown = td;
  }
}

export function init() {
  window.addEventListener("hashchange", dispatch);
  dispatch();
}
