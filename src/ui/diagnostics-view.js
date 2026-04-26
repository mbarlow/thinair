import { el, clear } from "./util.js";

function check(label, ok, detail) {
  return el("div", { class: "row", style: { alignItems: "center", justifyContent: "space-between" } },
    el("span", {}, label),
    el("span", { class: "tag " + (ok ? "ok" : "err") }, ok ? "ok" : "missing"),
    detail ? el("span", { class: "kv" }, detail) : null
  );
}

export function renderDiagnostics(root) {
  clear(root);
  const panel = el("section", { class: "panel" },
    el("h1", {}, "Diagnostics"),
    el("p", { class: "hint" }, "Quick check of browser features ThinAir relies on.")
  );

  const list = el("div", { class: "col" });
  panel.appendChild(list);

  const isSecure = window.isSecureContext;
  list.appendChild(check("Secure context (HTTPS or localhost)", isSecure, isSecure ? location.protocol : "needed for camera/mic"));
  list.appendChild(check("RTCPeerConnection", typeof RTCPeerConnection !== "undefined"));
  list.appendChild(check("RTCDataChannel", typeof RTCDataChannel !== "undefined" || typeof RTCPeerConnection !== "undefined"));
  list.appendChild(check("getUserMedia", !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)));
  list.appendChild(check("AudioContext", typeof (window.AudioContext || window.webkitAudioContext) !== "undefined"));
  list.appendChild(check("Canvas", !!document.createElement("canvas").getContext));
  list.appendChild(check("BarcodeDetector (optional)", typeof BarcodeDetector !== "undefined"));
  list.appendChild(check("jsQR (CDN)", typeof window.jsQR === "function"));
  list.appendChild(check("qrcode-generator (CDN)", typeof window.qrcode === "function"));
  list.appendChild(check("pako (CDN)", typeof window.pako !== "undefined"));

  // Mic / cam permission probes
  const micBtn = el("button", {}, "Test microphone");
  const camBtn = el("button", {}, "Test camera");
  const permLog = el("div", { class: "log" });
  panel.appendChild(el("hr", { class: "divider" }));
  panel.appendChild(el("div", { class: "btn-group" }, micBtn, camBtn));
  panel.appendChild(permLog);

  micBtn.addEventListener("click", async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      permLog.textContent = "Microphone OK. " + s.getAudioTracks().map(t => t.label).join(", ");
      for (const t of s.getTracks()) t.stop();
    } catch (e) {
      permLog.textContent = "Microphone failed: " + e.message;
    }
  });
  camBtn.addEventListener("click", async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
      permLog.textContent = "Camera OK. " + s.getVideoTracks().map(t => t.label).join(", ");
      for (const t of s.getTracks()) t.stop();
    } catch (e) {
      permLog.textContent = "Camera failed: " + e.message;
    }
  });

  // STUN reachability test (best-effort)
  const stunRow = el("div", { class: "kv", style: { marginTop: "8px" } }, "STUN: untested");
  panel.appendChild(stunRow);

  (async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.createDataChannel("probe");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      let foundSrflx = false;
      const t0 = Date.now();
      pc.addEventListener("icecandidate", (e) => {
        if (e.candidate && e.candidate.candidate.includes(" typ srflx")) foundSrflx = true;
      });
      const wait = () => new Promise((res) => {
        if (pc.iceGatheringState === "complete") return res();
        const t = setTimeout(res, 4000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); }
        });
      });
      await wait();
      stunRow.textContent = foundSrflx
        ? "STUN: reachable, srflx candidate gathered (" + (Date.now() - t0) + "ms)"
        : "STUN: no srflx candidate — peers on different networks may fail without TURN";
      pc.close();
    } catch (e) {
      stunRow.textContent = "STUN: probe error: " + e.message;
    }
  })();

  root.appendChild(panel);
}
