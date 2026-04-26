import { el, clear } from "./util.js";

export function renderHome(root) {
  clear(root);
  root.appendChild(
    el("section", { class: "panel" },
      el("h1", {}, "ThinAir"),
      el("p", { class: "muted" }, "Send files through the air. No cloud, no account, no backend."),
      el("div", { class: "tile-grid" },
        el("a", { class: "tile", href: "#/send" },
          el("h3", {}, "Send"),
          el("p", {}, "Pick a file. Pair with QR or chirp. Beam.")
        ),
        el("a", { class: "tile", href: "#/receive" },
          el("h3", {}, "Receive"),
          el("p", {}, "Show offer or scan one. Listen for chirps.")
        ),
        el("a", { class: "tile", href: "#/manual" },
          el("h3", {}, "Manual Pair"),
          el("p", {}, "Copy/paste offers and answers as text.")
        ),
        el("a", { class: "tile", href: "#/diagnostics" },
          el("h3", {}, "Diagnostics"),
          el("p", {}, "Check support: WebRTC, camera, microphone.")
        ),
      ),
      el("hr", { class: "divider" }),
      el("p", { class: "hint" },
        "How it works: the file moves over WebRTC. The handshake moves through QR codes, audio chirps, or pasted text. Both devices must be online during the transfer."
      )
    )
  );
}
