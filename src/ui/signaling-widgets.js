// Reusable widgets that present an offer/answer payload via QR / audio chirp / text,
// and accept an offer/answer via QR scan / chirp listen / text paste.
//
// Payload model: a Uint8Array from sdp-pack. QR/text encodes as base64url
// (with thinair: or #thinair= prefix). Audio sends the raw bytes through FSK.

import { el, clear, copyText, toast } from "./util.js";
import { AnimatedQR } from "../qr/qr-generate.js";
import { QRScanner } from "../qr/qr-scan.js";
import { ChirpPlayer, buildChirpForPayload } from "../audio/chirp-encode.js";
import { ChirpDecoder } from "../audio/chirp-decode.js";
import { bytesToText, parsePayloadFromText, parsePayloadFromBytes } from "../webrtc/signaling.js";

// PRESENT widget. payloadBytes is a Uint8Array.
export function presentPayload(payloadBytes, opts = {}) {
  const wrap = el("div", { class: "col" });

  const tabs = el("div", { class: "subtabs" },
    btn("QR"), btn("Audio"), btn("Text")
  );
  function btn(label) { return el("button", { type: "button" }, label); }

  const body = el("div", {});
  let mode = "qr";
  let animQR = null;
  let chirpPlayer = null;
  let audioCtx = null;
  let chirpStatus = null;

  const textForQR = "thinair:" + bytesToText(payloadBytes);
  const urlForQR = (opts.urlPrefix || (location.href.split("#")[0])) + "#thinair=" + bytesToText(payloadBytes);

  function setMode(m) {
    mode = m;
    for (const b of tabs.children) {
      b.classList.toggle("active", b.textContent.toLowerCase() === m);
    }
    clear(body);
    if (animQR) { animQR.stop(); animQR = null; }
    if (chirpPlayer) { chirpPlayer.stop(); chirpPlayer = null; }
    if (m === "qr") renderQRMode();
    else if (m === "audio") renderAudioMode();
    else renderTextMode();
  }

  function renderQRMode() {
    const qrBox = el("div", { class: "qr-wrap center-block" });
    const stat = el("div", { class: "kv center", style: { marginTop: "8px" } }, "");
    body.appendChild(qrBox);
    body.appendChild(stat);
    const finalText = (opts.urlPrefix === false) ? textForQR : urlForQR;
    animQR = new AnimatedQR(qrBox, finalText, { intervalMs: 350 });
    animQR.start().then(() => {
      const frames = animQR.frames.length;
      stat.textContent = frames === 1
        ? `Single QR · ${finalText.length} chars · ${payloadBytes.length} packed bytes`
        : `Animated QR · ${frames} frames · ${finalText.length} chars`;
    }).catch((e) => {
      stat.textContent = "QR error: " + e.message + ". Use Text fallback.";
    });
  }

  function renderAudioMode() {
    const sessionId = opts.sessionId || "thinair";
    const profileSel = el("select", {},
      el("option", { value: "birdsong-v1" }, "birdsong (default)"),
      el("option", { value: "modem-v1" }, "modem"),
      el("option", { value: "diagnostic-v1" }, "diagnostic (slow)"),
    );
    const repeatInput = el("input", { type: "number", value: 4, min: 1, max: 30, style: { width: "80px" } });
    const playBtn = el("button", { class: "primary" }, "Play chirp");
    const stopBtn = el("button", {}, "Stop");
    const planRow = el("div", { class: "kv" }, "");
    const progressBar = el("div", { class: "progress" }, el("div"));
    const progressLabel = el("div", { class: "kv" }, "");
    const cycleRow = el("div", { class: "kv" }, "");
    const frameGrid = el("div", { class: "frame-list" });
    chirpStatus = el("div", { class: "kv" }, "Ready.");

    body.appendChild(el("div", { class: "row" },
      el("div", { class: "col grow" }, el("label", {}, "Profile"), profileSel),
      el("div", { class: "col" }, el("label", {}, "Repeats"), repeatInput),
    ));
    body.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, playBtn, stopBtn));
    body.appendChild(planRow);
    body.appendChild(progressBar);
    body.appendChild(progressLabel);
    body.appendChild(cycleRow);
    body.appendChild(frameGrid);
    body.appendChild(chirpStatus);
    body.appendChild(el("p", { class: "hint", style: { marginTop: "8px" } },
      `Sending ${payloadBytes.length} bytes. Hold the device speaker near the other device's microphone. Each cycle plays the full payload; the receiver only needs each frame to land cleanly once across all cycles.`
    ));

    function fmtTime(s) {
      const m = Math.floor(s / 60);
      const r = Math.round(s % 60);
      return m > 0 ? `${m}m ${r}s` : `${r}s`;
    }

    function renderPlanFrameGrid(frameCount) {
      while (frameGrid.firstChild) frameGrid.removeChild(frameGrid.firstChild);
      for (let i = 1; i <= frameCount; i++) {
        const c = el("div", { class: "frame-cell" }, String(i));
        frameGrid.appendChild(c);
      }
    }

    function updatePlan() {
      try {
        const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
        const built = buildChirpForPayload(tempCtx, payloadBytes, sessionId, profileSel.value);
        const cycleSec = built.buffer.duration;
        const repeats = parseInt(repeatInput.value, 10) || 1;
        const totalSec = cycleSec * repeats + (repeats - 1) * 0.25;
        planRow.textContent =
          `${built.frames.length} frame${built.frames.length === 1 ? "" : "s"} · ${cycleSec.toFixed(1)}s/cycle · ` +
          `${repeats} cycle${repeats === 1 ? "" : "s"} = ~${fmtTime(totalSec)} total`;
        renderPlanFrameGrid(built.frames.length);
        try { tempCtx.close(); } catch {}
      } catch (e) {
        planRow.textContent = "(plan error: " + e.message + ")";
      }
    }
    profileSel.addEventListener("change", updatePlan);
    repeatInput.addEventListener("input", updatePlan);
    updatePlan();

    let playStartedAt = 0;
    let cycleSec = 0;
    let totalSec = 0;
    let raf = 0;
    function startTimer() {
      cancelAnimationFrame(raf);
      const tick = () => {
        if (!chirpPlayer || !chirpPlayer.playing) return;
        const elapsed = (performance.now() - playStartedAt) / 1000;
        const pct = Math.min(100, (elapsed / totalSec) * 100);
        progressBar.firstElementChild.style.width = pct.toFixed(1) + "%";
        progressLabel.textContent = `${fmtTime(elapsed)} / ${fmtTime(totalSec)}  (${pct.toFixed(0)}%)`;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    playBtn.addEventListener("click", async () => {
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") await audioCtx.resume();
        if (payloadBytes.length > 8192) {
          chirpStatus.textContent = "Payload too large for chirp: " + payloadBytes.length + " bytes. Use QR.";
          return;
        }
        const built = buildChirpForPayload(audioCtx, payloadBytes, sessionId, profileSel.value);
        renderPlanFrameGrid(built.frames.length);
        cycleSec = built.buffer.duration;
        const repeats = parseInt(repeatInput.value, 10) || 3;
        totalSec = cycleSec * repeats + (repeats - 1) * 0.25;
        progressBar.classList.remove("ok");
        progressBar.firstElementChild.style.width = "0%";
        chirpPlayer = new ChirpPlayer(audioCtx);
        playStartedAt = performance.now();
        chirpPlayer.play(built.buffer, repeats,
          (n, max) => { cycleRow.textContent = `Cycle ${n}/${max}`; },
          (done) => {
            cancelAnimationFrame(raf);
            progressBar.firstElementChild.style.width = "100%";
            if (done) progressBar.classList.add("ok");
            chirpStatus.textContent = done ? "Finished playing." : "Stopped.";
          }
        );
        chirpStatus.textContent = "Playing… keep devices close.";
        cycleRow.textContent = `Cycle 1/${repeats}`;
        startTimer();
      } catch (e) {
        chirpStatus.textContent = "Audio error: " + e.message;
      }
    });
    stopBtn.addEventListener("click", () => {
      cancelAnimationFrame(raf);
      if (chirpPlayer) chirpPlayer.stop();
    });
  }

  function renderTextMode() {
    const ta = el("textarea", { readonly: true, rows: 8 });
    ta.value = textForQR;
    const copy = el("button", { class: "primary" }, "Copy");
    const len = el("div", { class: "kv" }, `${textForQR.length} chars · ${payloadBytes.length} packed bytes`);
    body.appendChild(ta);
    body.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, copy, len));
    body.appendChild(el("p", { class: "hint" }, "Paste this text on the other device's matching screen."));
    copy.addEventListener("click", () => copyText(textForQR).then(() => toast("Copied")));
  }

  for (const b of tabs.children) {
    b.addEventListener("click", () => setMode(b.textContent.toLowerCase()));
  }
  wrap.appendChild(tabs);
  wrap.appendChild(body);
  setMode(opts.defaultMode || "qr");

  return {
    node: wrap,
    dispose() {
      if (animQR) animQR.stop();
      if (chirpPlayer) chirpPlayer.stop();
      if (audioCtx) try { audioCtx.close(); } catch {}
    },
  };
}

// CAPTURE widget. onPayload(envelope) where envelope = { type, sdp, id }.
export function capturePayload(onPayload, opts = {}) {
  const wrap = el("div", { class: "col" });
  const tabs = el("div", { class: "subtabs" },
    btn("QR"), btn("Audio"), btn("Text")
  );
  function btn(label) { return el("button", { type: "button" }, label); }

  const body = el("div", {});
  let mode = "qr";
  let scanner = null;
  let decoder = null;

  function setMode(m) {
    mode = m;
    for (const b of tabs.children) b.classList.toggle("active", b.textContent.toLowerCase() === m);
    clear(body);
    if (scanner) { scanner.stop(); scanner = null; }
    if (decoder) { decoder.stop(); decoder = null; }
    if (m === "qr") renderQRMode();
    else if (m === "audio") renderAudioMode();
    else renderTextMode();
  }

  function deliverFromText(text) {
    try {
      const env = parsePayloadFromText(text);
      onPayload(env);
    } catch (e) {
      onPayload({ error: e.message });
    }
  }

  function deliverFromBytes(bytes) {
    try {
      const env = parsePayloadFromBytes(bytes);
      onPayload(env);
    } catch (e) {
      onPayload({ error: e.message });
    }
  }

  function renderQRMode() {
    const video = el("video", { muted: true, playsinline: true, autoplay: true });
    const scanBox = el("div", { class: "scan-wrap" }, video, el("div", { class: "scan-overlay" }));
    const status = el("div", { class: "kv" }, "Tap Start to use the camera.");
    const startBtn = el("button", { class: "primary" }, "Start camera");
    const stopBtn = el("button", {}, "Stop");
    body.appendChild(scanBox);
    body.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, startBtn, stopBtn));
    body.appendChild(status);
    startBtn.addEventListener("click", async () => {
      try {
        scanner = new QRScanner(video);
        await scanner.start(
          (text) => { status.textContent = "Got QR (" + text.length + " chars)"; deliverFromText(text); },
          (s) => { if (s.kind === "fragment") status.textContent = `Animated QR ${s.have}/${s.total}…`; }
        );
        status.textContent = "Scanning…";
      } catch (e) {
        status.textContent = "Camera error: " + e.message;
      }
    });
    stopBtn.addEventListener("click", () => { if (scanner) scanner.stop(); });
  }

  function renderAudioMode() {
    const profileSel = el("select", {},
      el("option", { value: "birdsong-v1" }, "birdsong"),
      el("option", { value: "modem-v1" }, "modem"),
      el("option", { value: "diagnostic-v1" }, "diagnostic"),
    );
    const startBtn = el("button", { class: "primary" }, "Start listening");
    const stopBtn = el("button", {}, "Stop");
    const status = el("div", { class: "kv" }, "Idle.");
    const progressLabel = el("div", { class: "kv" }, "");
    const frames = el("div", { class: "frame-list" });
    const meter = el("canvas", { class: "viz" });
    body.appendChild(el("div", { class: "row" }, el("div", { class: "col grow" }, el("label", {}, "Profile"), profileSel)));
    body.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, startBtn, stopBtn));
    body.appendChild(meter);
    body.appendChild(status);
    body.appendChild(progressLabel);
    body.appendChild(frames);
    body.appendChild(el("p", { class: "hint" }, "Each red square is a missing frame; each green is locked in. Decode finishes when every cell is green. The receiver keeps every frame it ever decoded — frames missed in cycle 1 just need to land cleanly in any later cycle."));

    let levelRing = new Float32Array(120);
    let levelIdx = 0;
    function drawMeter() {
      const ctx = meter.getContext("2d");
      const w = meter.width = meter.clientWidth;
      const h = meter.height = meter.clientHeight;
      ctx.fillStyle = "#07090d";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#6ee7ff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < levelRing.length; i++) {
        const x = (i / levelRing.length) * w;
        const v = levelRing[(levelIdx + i) % levelRing.length];
        const y = h - Math.min(h, v * h * 6);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    let drawing = false;
    function startDraw() {
      if (drawing) return;
      drawing = true;
      const tick = () => {
        if (!drawing) return;
        drawMeter();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    startBtn.addEventListener("click", async () => {
      try {
        decoder = new ChirpDecoder(profileSel.value);
        await decoder.start({
          onFrame: (info) => {
            status.textContent = `Frame ${info.seq}/${info.total} · have ${info.have}` + (info.missing.length ? ` · missing ${info.missing.join(",")}` : "");
            progressLabel.textContent = `${info.have}/${info.total} frames decoded`;
            renderFrames(frames, info.have, info.total, info.missing);
            if (info.complete) status.textContent += " · complete";
          },
          onSignal: (s) => {
            if (s.kind === "complete") {
              status.textContent = `Decoded ${s.payload.length} bytes`;
              deliverFromBytes(s.payload);
            } else if (s.kind === "sync-rising") {
              status.textContent = "Sync tone detected, waiting for falling edge…";
            } else if (s.kind === "sync-locked") {
              status.textContent = "Sync locked. Reading frame…";
            } else if (s.kind === "bad-frame") {
              status.textContent = "Bad frame (CRC failed) — resyncing…";
            } else if (s.kind === "abort") {
              status.textContent = "Aborted (" + s.reason + "), resyncing…";
            }
          },
          onLevel: (lvl) => {
            levelRing[levelIdx] = lvl;
            levelIdx = (levelIdx + 1) % levelRing.length;
          },
        });
        status.textContent = "Listening…";
        startDraw();
      } catch (e) {
        status.textContent = "Mic error: " + e.message;
      }
    });
    stopBtn.addEventListener("click", () => { drawing = false; if (decoder) decoder.stop(); });
  }

  function renderFrames(host, have, total, missing) {
    if (!total) return;
    if (host.children.length !== total) {
      clear(host);
      for (let i = 1; i <= total; i++) {
        const c = el("div", { class: "frame-cell" }, String(i));
        host.appendChild(c);
      }
    }
    const missSet = new Set(missing);
    for (let i = 0; i < total; i++) {
      const cell = host.children[i];
      cell.classList.remove("have", "miss");
      if (missSet.has(i + 1)) cell.classList.add("miss");
      else cell.classList.add("have");
    }
  }

  function renderTextMode() {
    const ta = el("textarea", { rows: 8, placeholder: "Paste payload text here…" });
    const submit = el("button", { class: "primary" }, "Use this");
    body.appendChild(ta);
    body.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, submit));
    submit.addEventListener("click", () => {
      const v = ta.value.trim();
      if (!v) return;
      deliverFromText(v);
    });
  }

  for (const b of tabs.children) {
    b.addEventListener("click", () => setMode(b.textContent.toLowerCase()));
  }
  wrap.appendChild(tabs);
  wrap.appendChild(body);
  setMode(opts.defaultMode || "qr");

  return {
    node: wrap,
    dispose() {
      if (scanner) scanner.stop();
      if (decoder) decoder.stop();
    },
  };
}
