// ThinAir entry point.
import { on, init, go } from "./router.js";
import { renderHome } from "./ui/home-view.js";
import { renderSend } from "./ui/send-view.js";
import { renderReceive } from "./ui/receive-view.js";
import { renderManual } from "./ui/manual-view.js";
import { renderDiagnostics } from "./ui/diagnostics-view.js";

on("/", renderHome);
on("/send", renderSend);
on("/receive", renderReceive);
on("/manual", renderManual);
on("/diagnostics", renderDiagnostics);

// Wait for CDN libs to load before initializing the router so views see them.
function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (predicate()) { clearInterval(t); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(t); reject(new Error("timeout")); }
    }, 30);
  });
}

(async () => {
  try {
    await waitFor(() => typeof window.qrcode === "function" && window.jsQR && window.pako);
  } catch (e) {
    // Continue anyway — diagnostics will still surface issues.
    console.warn("CDN libs not fully loaded:", e);
  }

  // If page was opened with a #thinair=... payload, the home page can prompt the user.
  // For v1 we just route to home; the user can paste it into Receive/Manual.
  init();

  // If hash has a thinair payload, hint the user.
  const raw = (location.hash || "").slice(1);
  if (raw.startsWith("/thinair=") || raw.startsWith("thinair=")) {
    const payload = raw.replace(/^\/?thinair=/, "");
    sessionStorage.setItem("thinair-incoming", payload);
    // Auto-route to receive
    go("/receive");
  }
})();
