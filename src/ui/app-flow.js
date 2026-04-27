// ThinAir flow controller. Single linear state machine, mobile-first.
//
//   home --tap Send-->    send/picking ---picked---> send/qr ---cue---> send/scan ---qr---> send/transfer ---> done
//   home --tap Receive--> recv/scan    ---qr-------> recv/qr   (cue)--> recv/transfer ---> done

import { el, clear, fmtBytes } from "./util.js";
import { renderQR } from "../qr/qr-generate.js";
import { QRScanner } from "../qr/qr-scan.js";
import { createPeer, createOffer, createAnswer, applyAnswer, watchConnection } from "../webrtc/peer.js";
import { sendFiles, receiveFiles, downloadBlob } from "../webrtc/file-transfer.js";
import { makeOfferBytes, makeAnswerBytes, bytesToText, parsePayloadFromText, newSessionId } from "../webrtc/signaling.js";
import { playCue, CueListener } from "../audio/cue.js";
import { shatterQR, crossfadeIn, crossfadeOut } from "./animations.js";

const stage = () => document.getElementById("stage");

// One-shot file picker helper. The user gesture must be the calling click.
function pickFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (multiple) input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function transition(buildNext) {
  const root = stage();
  const old = root.firstElementChild;
  if (old) {
    if (typeof old._dispose === "function") {
      try { old._dispose(); } catch {}
    }
    await crossfadeOut(old);
  }
  clear(root);
  const node = await buildNext();
  if (!node) return;
  root.appendChild(node);
  await crossfadeIn(node);
}

// ─── HOME ────────────────────────────────────────────────────────────────────

export function startApp() {
  showHome();
}

function showHome() {
  transition(() => {
    const wrap = el("section", { class: "stage-page home-page" },
      el("div", { class: "home-brand" },
        el("div", { class: "logo big" }),
        el("h1", {}, "ThinAir"),
        el("p", { class: "muted center" }, "Send files device to device. No cloud."),
      ),
      el("div", { class: "home-actions" },
        el("button", { class: "tile-btn primary", onclick: () => onSend() },
          el("div", { class: "tile-icon" }, iconSend()),
          el("div", { class: "tile-label" }, "Send")
        ),
        el("button", { class: "tile-btn", onclick: () => onReceive() },
          el("div", { class: "tile-icon" }, iconReceive()),
          el("div", { class: "tile-label" }, "Receive")
        ),
      ),
      el("div", { class: "home-foot" },
        el("a", { href: "#/diagnostics", class: "muted small" }, "Diagnostics")
      )
    );
    return wrap;
  });
}

async function onSend() {
  // Must trigger picker inside the user gesture.
  const files = await pickFiles({ multiple: true });
  if (!files.length) { showHome(); return; }
  startSendFlow(files);
}

function onReceive() {
  startReceiveFlow();
}

// ─── SEND FLOW ───────────────────────────────────────────────────────────────

async function startSendFlow(files) {
  const session = newSessionId();
  const pc = createPeer();
  const channel = pc.createDataChannel("thinair-file", { ordered: true });
  let sendStarted = false;

  // Pre-show waiting screen while ICE gathers.
  await transition(() => buildBusyScreen("Preparing handshake…", `Packing ${files.length} ${files.length === 1 ? "file" : "files"} (${fmtBytes(files.reduce((a, f) => a + f.size, 0))}).`));

  const offerDesc = await createOffer(pc);
  const offerBytes = makeOfferBytes(offerDesc.sdp, session);
  const offerText = "thinair:" + bytesToText(offerBytes);

  // Show offer QR + listen for receiver's "I'm ready" cue.
  const cueListener = new CueListener();
  let scannedAlready = false;

  await transition(() => {
    const node = buildSendQRScreen({
      files,
      offerText,
      onManualScan: () => { /* no-op until cue or button */ },
    });
    node._dispose = () => { try { cueListener.stop(); } catch {} };
    return node;
  });

  let cueHeard = false;
  const advanceToScan = async () => {
    if (cueHeard) return;
    cueHeard = true;
    cueListener.stop();
    if (scannedAlready) return;
    await shatterCurrentQR();
    await transition(() => buildScanScreen("Scan the receiver's code", async (env) => {
      if (scannedAlready) return;
      scannedAlready = true;
      try {
        if (env.error) throw new Error(env.error);
        if (env.type !== "answer") throw new Error("expected answer, got " + env.type);
        await applyAnswer(pc, { type: "answer", sdp: env.sdp });
        await transition(() => buildSendingScreen(files));
      } catch (e) {
        await transition(() => buildErrorScreen("Couldn't apply answer", e.message));
      }
    }));
  };

  // Try mic; if denied, show a manual button on the QR screen.
  cueListener.start(advanceToScan).then((ok) => {
    if (!ok) addManualReadyButton(advanceToScan);
  });

  watchConnection(pc, () => {});
  channel.addEventListener("open", async () => {
    if (sendStarted) return;
    sendStarted = true;
    await sendFilesWithUI(channel, files);
  });
}

function addManualReadyButton(handler) {
  const btnRow = document.querySelector(".manual-ready-row");
  if (!btnRow) return;
  btnRow.style.display = "";
  const btn = btnRow.querySelector("button");
  btn.addEventListener("click", () => handler());
}

function buildSendQRScreen({ files, offerText }) {
  const summary = files.length === 1
    ? `${files[0].name} · ${fmtBytes(files[0].size)}`
    : `${files.length} files · ${fmtBytes(files.reduce((a, f) => a + f.size, 0))}`;
  const qrHost = el("div", { class: "qr-stage", id: "qrhost" });
  const wrap = el("section", { class: "stage-page qr-page" },
    el("div", { class: "step-label" }, "Step 1 of 2"),
    el("h2", { class: "center" }, "Have your friend scan this"),
    el("div", { class: "qr-frame" }, qrHost),
    el("div", { class: "kv center" }, summary),
    el("div", { class: "manual-ready-row btn-group center", style: { display: "none", marginTop: "12px" } },
      el("button", { class: "btn primary" }, "Receiver ready — switch to my camera")
    ),
    el("p", { class: "hint center" }, "When the receiver shows their code, this device will switch to camera mode automatically.")
  );
  setTimeout(() => renderQR(qrHost, offerText, { size: Math.min(360, qrHost.clientWidth || 360) }).catch(() => {}), 0);
  return wrap;
}

async function shatterCurrentQR() {
  const qrHost = document.getElementById("qrhost");
  if (qrHost) await shatterQR(qrHost);
}

async function sendFilesWithUI(channel, files) {
  await transition(() => buildSendingScreen(files));
  const ui = sendingUIRefs();
  let cancelled = false;
  ui.cancelBtn.addEventListener("click", () => { cancelled = true; channel.close(); });
  try {
    await sendFiles(channel, files, {
      isCancelled: () => cancelled,
      onFileStart: ({ index, file }) => {
        ui.line.textContent = `${index + 1}/${files.length}: ${file.name}`;
        ui.bar.firstElementChild.style.width = "0%";
      },
      onChunk: ({ fileSent, fileSize }) => {
        const pct = fileSize ? (fileSent / fileSize * 100) : 100;
        ui.bar.firstElementChild.style.width = pct.toFixed(1) + "%";
      },
      onComplete: () => {
        ui.bar.classList.add("ok");
        ui.bar.firstElementChild.style.width = "100%";
        showCompleteScreen(`Sent ${files.length} file${files.length === 1 ? "" : "s"}.`);
      },
    });
  } catch (e) {
    await transition(() => buildErrorScreen("Send failed", e.message));
  }
}

function buildSendingScreen(files) {
  const bar = el("div", { class: "progress big" }, el("div"));
  const line = el("div", { class: "kv center", style: { marginTop: "8px" } },
    files.length === 1 ? files[0].name : `${files.length} files`);
  const cancelBtn = el("button", { class: "btn warn" }, "Cancel");
  const wrap = el("section", { class: "stage-page transfer-page" },
    el("h2", { class: "center" }, "Sending"),
    bar, line,
    el("div", { class: "btn-group center", style: { marginTop: "16px" } }, cancelBtn)
  );
  wrap.dataset.sending = "1";
  wrap._refs = { bar, line, cancelBtn };
  return wrap;
}

function sendingUIRefs() {
  return stage().querySelector("[data-sending]")._refs;
}

// ─── RECEIVE FLOW ────────────────────────────────────────────────────────────

async function startReceiveFlow() {
  await transition(() => buildScanScreen("Scan the sender's code", async (env) => {
    if (env.error) {
      await transition(() => buildErrorScreen("Couldn't read code", env.error));
      return;
    }
    if (env.type !== "offer") {
      await transition(() => buildErrorScreen("Wrong code type", "Expected an offer."));
      return;
    }
    await onOfferDecoded(env);
  }));
}

async function onOfferDecoded(off) {
  const session = off.id || newSessionId();
  const pc = createPeer();
  let receiveStarted = false;
  const incomingFiles = []; // {meta, blob}

  pc.addEventListener("datachannel", (ev) => {
    const ch = ev.channel;
    receiveFiles(ch, {
      onBatch: ({ count }) => {
        if (!receiveStarted) {
          receiveStarted = true;
          showReceivingScreen(count);
        }
      },
      onFileStart: ({ index, meta, batch }) => {
        const ui = receivingUIRefs();
        if (ui) {
          ui.line.textContent = `${index + 1}/${batch ? batch.count : "?"}: ${meta.name}`;
          ui.bar.firstElementChild.style.width = "0%";
          ui.list.appendChild(el("div", { class: "kv recv-row", id: `recv-row-${index}` }, `${meta.name} · ${fmtBytes(meta.size)}…`));
        }
      },
      onChunk: ({ fileReceived, fileSize }) => {
        const ui = receivingUIRefs();
        if (ui) {
          const pct = fileSize ? (fileReceived / fileSize * 100) : 100;
          ui.bar.firstElementChild.style.width = pct.toFixed(1) + "%";
        }
      },
      onFileDone: ({ index, meta, blob }) => {
        downloadBlob(blob, meta.name);
        const row = document.getElementById(`recv-row-${index}`);
        if (row) row.textContent = `✓ ${meta.name} · ${fmtBytes(meta.size)}`;
        incomingFiles.push({ meta, blob });
      },
      onComplete: () => {
        const ui = receivingUIRefs();
        if (ui) ui.bar.classList.add("ok");
        showCompleteScreen(`Received ${incomingFiles.length} file${incomingFiles.length === 1 ? "" : "s"}.`);
      },
      onError: async (err) => {
        await transition(() => buildErrorScreen("Receive error", err.message));
      },
    });
  });

  await transition(() => buildBusyScreen("Building answer…", "Crunching ICE candidates."));
  const ansDesc = await createAnswer(pc, { type: "offer", sdp: off.sdp });
  const ansBytes = makeAnswerBytes(ansDesc.sdp, session);
  const ansText = "thinair:" + bytesToText(ansBytes);

  // Big "Success!" splash, then the answer QR.
  await transition(() => buildSuccessSplash());
  await new Promise((r) => setTimeout(r, 700));
  await transition(() => buildReceiveQRScreen(ansText));
  // Audible cue so the sender's mic can advance.
  playCue().catch(() => {});
}

function buildSuccessSplash() {
  return el("section", { class: "stage-page splash-page" },
    el("div", { class: "splash-success" }, "✓ Code received")
  );
}

function buildReceiveQRScreen(answerText) {
  const qrHost = el("div", { class: "qr-stage", id: "qrhost" });
  const wrap = el("section", { class: "stage-page qr-page" },
    el("div", { class: "step-label" }, "Step 2 of 2"),
    el("h2", { class: "center" }, "Show this back to the sender"),
    el("div", { class: "qr-frame" }, qrHost),
    el("p", { class: "hint center" }, "A short tone is playing so the sender's device can switch to its camera automatically."),
  );
  setTimeout(() => renderQR(qrHost, answerText, { size: Math.min(360, qrHost.clientWidth || 360) }).catch(() => {}), 0);
  return wrap;
}

function showReceivingScreen(count) {
  transition(() => {
    const bar = el("div", { class: "progress big" }, el("div"));
    const line = el("div", { class: "kv center", style: { marginTop: "8px" } }, "—");
    const list = el("div", { class: "kv col", style: { marginTop: "8px", gap: "4px" } });
    const wrap = el("section", { class: "stage-page transfer-page" },
      el("h2", { class: "center" }, "Receiving"),
      bar, line, list
    );
    wrap.dataset.receiving = "1";
    wrap._refs = { bar, line, list };
    return wrap;
  });
}

function receivingUIRefs() {
  const node = stage().querySelector("[data-receiving]");
  return node ? node._refs : null;
}

// ─── SHARED SCREENS ──────────────────────────────────────────────────────────

function buildScanScreen(title, onResult) {
  const video = el("video", { muted: true, playsinline: true, autoplay: true });
  const scanBox = el("div", { class: "scan-stage" }, video, el("div", { class: "scan-overlay" }));
  const status = el("div", { class: "kv center", style: { marginTop: "8px" } }, "Starting camera…");
  const wrap = el("section", { class: "stage-page scan-page" },
    el("h2", { class: "center" }, title),
    scanBox,
    status
  );
  setTimeout(async () => {
    try {
      const scanner = new QRScanner(video);
      wrap._scanner = scanner;
      wrap._dispose = () => { try { scanner.stop(); } catch {} };
      await scanner.start(
        async (text) => {
          status.textContent = "Got it. Decoding…";
          try {
            const env = parsePayloadFromText(text);
            await onResult(env);
          } catch (e) {
            await onResult({ error: e.message });
          }
        },
        (s) => { if (s.kind === "fragment") status.textContent = `Animated QR ${s.have}/${s.total}…`; }
      );
      status.textContent = "Scanning…";
    } catch (e) {
      status.textContent = "Camera error: " + e.message;
    }
  }, 0);
  return wrap;
}

function buildBusyScreen(title, sub) {
  return el("section", { class: "stage-page busy-page" },
    el("div", { class: "spinner" }),
    el("h2", { class: "center" }, title),
    el("p", { class: "muted center" }, sub || "")
  );
}

function buildErrorScreen(title, sub) {
  return el("section", { class: "stage-page error-page" },
    el("h2", { class: "center" }, title || "Something went wrong"),
    el("p", { class: "muted center" }, sub || ""),
    el("div", { class: "btn-group center", style: { marginTop: "16px" } },
      el("button", { class: "btn primary", onclick: () => showHome() }, "Back to home")
    )
  );
}

function showCompleteScreen(message) {
  setTimeout(() => transition(() => el("section", { class: "stage-page done-page" },
    el("div", { class: "splash-success" }, "✓ Done"),
    el("p", { class: "muted center" }, message),
    el("div", { class: "btn-group center", style: { marginTop: "16px" } },
      el("button", { class: "btn primary", onclick: () => showHome() }, "Back to home")
    )
  )), 400);
}

// ─── ICONS ────────────────────────────────────────────────────────────────────

function iconSend() {
  return svgEl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l18-9-7 18-3-7-8-2z"/></svg>`);
}
function iconReceive() {
  return svgEl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14M5 10l7 7 7-7M5 21h14"/></svg>`);
}
function svgEl(s) {
  const t = document.createElement("template");
  t.innerHTML = s.trim();
  return t.content.firstChild;
}
