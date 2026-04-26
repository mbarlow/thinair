// Send flow: sender is the offerer. Picks a file, creates an offer, presents it,
// captures the answer, connects, and streams the file.

import { el, clear, fmtBytes, logger } from "./util.js";
import { presentPayload, capturePayload } from "./signaling-widgets.js";
import { createPeer, createOffer, applyAnswer, watchConnection } from "../webrtc/peer.js";
import { sendFile } from "../webrtc/file-transfer.js";
import { makeOfferEnvelope, envelopeToString, parsePayload, newSessionId } from "../webrtc/signaling.js";

export function renderSend(root) {
  clear(root);
  const session = newSessionId();
  const root_ = root;
  const panel = el("section", { class: "panel" }, el("h1", {}, "Send"));
  root_.appendChild(panel);

  let pc = null;
  let channel = null;
  let file = null;
  let presentWidget = null;
  let captureWidget = null;
  let cancelled = false;

  // Step 1: file
  const filePanel = el("section", { class: "panel" });
  filePanel.appendChild(el("h2", {}, "1 · Choose file"));
  const fileInput = el("input", { type: "file" });
  filePanel.appendChild(fileInput);
  const fileInfo = el("div", { class: "kv", style: { marginTop: "8px" } }, "No file selected.");
  filePanel.appendChild(fileInfo);
  root_.appendChild(filePanel);

  // Step 2: offer present
  const offerPanel = el("section", { class: "panel" });
  offerPanel.appendChild(el("h2", {}, "2 · Show this to the receiver"));
  const offerHost = el("div", {});
  offerPanel.appendChild(offerHost);
  offerPanel.appendChild(el("p", { class: "hint" }, "Session code: " + session));
  root_.appendChild(offerPanel);

  // Step 3: answer capture
  const answerPanel = el("section", { class: "panel" });
  answerPanel.appendChild(el("h2", {}, "3 · Get the answer back"));
  const answerHost = el("div", {});
  answerPanel.appendChild(answerHost);
  answerPanel.appendChild(el("p", { class: "hint" }, "When the receiver shows their answer, scan / listen / paste it here."));
  root_.appendChild(answerPanel);

  // Step 4: status
  const statusPanel = el("section", { class: "panel" });
  statusPanel.appendChild(el("h2", {}, "4 · Transfer"));
  const stateBig = el("div", { class: "big-state" }, "Idle");
  const progress = el("div", { class: "progress" }, el("div"));
  const progressLine = el("div", { class: "kv" }, "—");
  const log = el("div", { class: "log" });
  const logFn = logger(log);
  const cancelBtn = el("button", { class: "danger" }, "Cancel");
  statusPanel.appendChild(stateBig);
  statusPanel.appendChild(progress);
  statusPanel.appendChild(progressLine);
  statusPanel.appendChild(el("div", { class: "btn-group", style: { marginTop: "8px" } }, cancelBtn));
  statusPanel.appendChild(log);
  root_.appendChild(statusPanel);

  cancelBtn.addEventListener("click", () => {
    cancelled = true;
    if (channel && channel.readyState === "open") {
      try { channel.send(JSON.stringify({ kind: "cancel" })); } catch {}
    }
    cleanup();
    stateBig.textContent = "Cancelled";
  });

  function cleanup() {
    if (presentWidget) try { presentWidget.dispose(); } catch {}
    if (captureWidget) try { captureWidget.dispose(); } catch {}
    if (channel) try { channel.close(); } catch {}
    if (pc) try { pc.close(); } catch {}
  }

  fileInput.addEventListener("change", async () => {
    file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileInfo.textContent = `${file.name} · ${fmtBytes(file.size)} · ${file.type || "application/octet-stream"}`;
    logFn(`Selected: ${file.name} (${fmtBytes(file.size)})`);
    await begin();
  });

  async function begin() {
    if (pc) try { pc.close(); } catch {}
    pc = createPeer();
    channel = pc.createDataChannel("thinair-file", { ordered: true });

    watchConnection(pc, (s) => {
      logFn(`pc: connection=${s.connection} ice=${s.ice} signaling=${s.signaling}`);
      if (s.connection === "connected" || s.connection === "completed") {
        stateBig.textContent = "Connected";
      } else if (s.connection === "connecting") {
        stateBig.textContent = "Connecting";
      } else if (s.connection === "failed") {
        stateBig.textContent = "Connection failed";
      } else if (s.connection === "disconnected") {
        stateBig.textContent = "Disconnected";
      }
    });

    channel.addEventListener("open", async () => {
      logFn("DataChannel open");
      stateBig.textContent = "Sending";
      try {
        await sendFile(channel, file, (sent, total) => {
          const pct = total ? (sent / total * 100) : 0;
          progress.firstElementChild.style.width = pct.toFixed(1) + "%";
          progressLine.textContent = `${fmtBytes(sent)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`;
        });
        progress.classList.add("ok");
        stateBig.textContent = "Complete";
        logFn("Transfer complete.");
      } catch (e) {
        stateBig.textContent = "Failed";
        logFn("Transfer error: " + e.message);
      }
    });
    channel.addEventListener("close", () => logFn("DataChannel closed"));
    channel.addEventListener("error", (e) => logFn("DataChannel error: " + (e && e.error && e.error.message || e)));

    stateBig.textContent = "Creating offer";
    logFn("Gathering ICE candidates…");
    const desc = await createOffer(pc);
    const env = makeOfferEnvelope(desc.sdp, session);
    const payload = envelopeToString(env);
    logFn(`Offer ready (${payload.length} chars)`);

    if (presentWidget) try { presentWidget.dispose(); } catch {}
    clear(offerHost);
    presentWidget = presentPayload(payload, { sessionId: session });
    offerHost.appendChild(presentWidget.node);

    if (captureWidget) try { captureWidget.dispose(); } catch {}
    clear(answerHost);
    captureWidget = capturePayload(async (text) => {
      try {
        const ans = parsePayload(text);
        if (ans.type !== "answer") {
          logFn("Expected answer, got: " + ans.type);
          return;
        }
        if (ans.id && ans.id !== session) {
          logFn("Session mismatch: " + ans.id + " vs " + session);
        }
        logFn("Applying answer…");
        stateBig.textContent = "Applying answer";
        await applyAnswer(pc, { type: "answer", sdp: ans.sdp });
      } catch (e) {
        logFn("Answer parse error: " + e.message);
      }
    });
    answerHost.appendChild(captureWidget.node);
  }

  return () => { cancelled = true; cleanup(); };
}
