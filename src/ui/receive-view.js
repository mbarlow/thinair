// Receive flow: receiver is the answerer. Captures an offer, creates an answer,
// presents it back, and downloads the file when DataChannel completes.

import { el, clear, fmtBytes, logger } from "./util.js";
import { presentPayload, capturePayload } from "./signaling-widgets.js";
import { createPeer, createAnswer, watchConnection } from "../webrtc/peer.js";
import { receiveFile, downloadBlob } from "../webrtc/file-transfer.js";
import { makeAnswerEnvelope, envelopeToString, parsePayload } from "../webrtc/signaling.js";

export function renderReceive(root) {
  clear(root);
  const root_ = root;
  const panel = el("section", { class: "panel" }, el("h1", {}, "Receive"));
  root_.appendChild(panel);

  let pc = null;
  let presentWidget = null;
  let captureWidget = null;
  let session = null;

  const offerPanel = el("section", { class: "panel" });
  offerPanel.appendChild(el("h2", {}, "1 · Get the offer"));
  const offerHost = el("div", {});
  offerPanel.appendChild(offerHost);
  offerPanel.appendChild(el("p", { class: "hint" }, "Scan, listen, or paste the sender's offer."));
  root_.appendChild(offerPanel);

  const answerPanel = el("section", { class: "panel" });
  answerPanel.appendChild(el("h2", {}, "2 · Give them the answer"));
  const answerHost = el("div", {});
  answerPanel.appendChild(answerHost);
  root_.appendChild(answerPanel);

  const statusPanel = el("section", { class: "panel" });
  statusPanel.appendChild(el("h2", {}, "3 · Transfer"));
  const stateBig = el("div", { class: "big-state" }, "Waiting for offer");
  const fileLine = el("div", { class: "kv" }, "—");
  const progress = el("div", { class: "progress" }, el("div"));
  const progressLine = el("div", { class: "kv" }, "—");
  const log = el("div", { class: "log" });
  const logFn = logger(log);
  const downloadAgain = el("button", {}, "Download again");
  downloadAgain.style.display = "none";
  statusPanel.appendChild(stateBig);
  statusPanel.appendChild(fileLine);
  statusPanel.appendChild(progress);
  statusPanel.appendChild(progressLine);
  statusPanel.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, downloadAgain));
  statusPanel.appendChild(log);
  root_.appendChild(statusPanel);

  let lastBlob = null;
  let lastName = null;
  downloadAgain.addEventListener("click", () => {
    if (lastBlob) downloadBlob(lastBlob, lastName);
  });

  // Pre-mount capture widget for offer
  captureWidget = capturePayload(async (text) => {
    try {
      const off = parsePayload(text);
      if (off.type !== "offer") {
        logFn("Expected offer, got: " + off.type);
        return;
      }
      session = off.id || "thinair";
      logFn(`Got offer (${text.length} chars)`);
      stateBig.textContent = "Building answer";

      pc = createPeer();
      pc.addEventListener("datachannel", (ev) => {
        const channel = ev.channel;
        channel.binaryType = "arraybuffer";
        channel.addEventListener("open", () => {
          logFn("DataChannel open");
          stateBig.textContent = "Receiving";
        });
        channel.addEventListener("close", () => logFn("DataChannel closed"));
        receiveFile(channel,
          (received, total, meta) => {
            if (meta) fileLine.textContent = `${meta.name} · ${fmtBytes(meta.size)} · ${meta.type}`;
            const pct = total ? received / total * 100 : 0;
            progress.firstElementChild.style.width = pct.toFixed(1) + "%";
            progressLine.textContent = `${fmtBytes(received)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`;
          },
          (blob, meta) => {
            stateBig.textContent = "Complete";
            progress.classList.add("ok");
            logFn(`Received ${meta.name} (${fmtBytes(meta.size)})`);
            lastBlob = blob;
            lastName = meta.name;
            downloadAgain.style.display = "";
            downloadBlob(blob, meta.name);
          },
          (err) => { stateBig.textContent = "Failed"; logFn("Receive error: " + err.message); }
        );
      });
      watchConnection(pc, (s) => {
        logFn(`pc: connection=${s.connection} ice=${s.ice}`);
        if (s.connection === "connected") stateBig.textContent = "Connected";
      });

      const desc = await createAnswer(pc, { type: "offer", sdp: off.sdp });
      const env = makeAnswerEnvelope(desc.sdp, session);
      const payload = envelopeToString(env);
      logFn(`Answer ready (${payload.length} chars)`);

      if (presentWidget) try { presentWidget.dispose(); } catch {}
      clear(answerHost);
      presentWidget = presentPayload(payload, { sessionId: session });
      answerHost.appendChild(presentWidget.node);
      stateBig.textContent = "Waiting for sender to read answer";
    } catch (e) {
      logFn("Offer parse error: " + e.message);
    }
  });
  offerHost.appendChild(captureWidget.node);

  return () => {
    try { if (presentWidget) presentWidget.dispose(); } catch {}
    try { if (captureWidget) captureWidget.dispose(); } catch {}
    if (pc) try { pc.close(); } catch {}
  };
}
