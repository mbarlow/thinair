// ThinAir entry point. PWA-ready single-flow app.
import { startApp } from "./ui/app-flow.js";
import { renderDiagnostics } from "./ui/diagnostics-view.js";

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (predicate()) { clearInterval(t); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(t); reject(new Error("timeout")); }
    }, 30);
  });
}

function fixupBuildPlaceholders() {
  const isPlaceholder = (s) => typeof s === "string" && s.includes("__BUILD_");
  for (const a of document.querySelectorAll("a, meta")) {
    if (a.tagName === "META") {
      if (isPlaceholder(a.content)) a.content = "dev";
      continue;
    }
    if (a.textContent && isPlaceholder(a.textContent)) a.textContent = a.textContent.replace(/__BUILD_SHA__/g, "dev");
    if (a.href && isPlaceholder(a.href)) a.href = "https://github.com/mbarlow/thinair";
    if (a.title && isPlaceholder(a.title)) a.title = "local dev build";
  }
}

function dispatchHash() {
  const raw = (location.hash || "").slice(1);
  if (raw === "/diagnostics") {
    renderDiagnostics(document.getElementById("stage"));
    return true;
  }
  return false;
}

(async () => {
  fixupBuildPlaceholders();
  try {
    await waitFor(() => typeof window.qrcode === "function" && window.jsQR && window.pako);
  } catch (e) {
    console.warn("CDN libs not fully loaded:", e);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  if (dispatchHash()) {
    window.addEventListener("hashchange", () => {
      if (!dispatchHash()) startApp();
    });
    return;
  }

  startApp();
  window.addEventListener("hashchange", () => {
    if (!dispatchHash()) startApp();
  });
})();
