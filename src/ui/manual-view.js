// Manual paste-only flow. No camera, no microphone. Always works.

import { el, clear, fmtBytes, copyText, toast, logger } from "./util.js";
import { createPeer, createOffer, createAnswer, applyAnswer, watchConnection } from "../webrtc/peer.js";
import { sendFile, receiveFile, downloadBlob } from "../webrtc/file-transfer.js";
import { makeOfferEnvelope, makeAnswerEnvelope, envelopeToString, parsePayload, newSessionId } from "../webrtc/signaling.js";

export function renderManual(root) {
  clear(root);
  const tabs = el("div", { class: "subtabs" }, btn("Send"), btn("Receive"));
  function btn(label) {
    return el("button", { type: "button" }, label);
  }
  const body = el("div", {});
  root.appendChild(el("section", { class: "panel" },
    el("h1", {}, "Manual Pair"),
    el("p", { class: "muted" }, "Plain text copy/paste. Works without camera or microphone."),
    tabs, body
  ));

  let teardown = null;
  function setMode(m) {
    if (teardown) try { teardown(); } catch {}
    teardown = null;
    for (const b of tabs.children) b.classList.toggle("active", b.textContent.toLowerCase() === m);
    clear(body);
    if (m === "send") teardown = renderManualSend(body);
    else teardown = renderManualReceive(body);
  }
  for (const b of tabs.children) b.addEventListener("click", () => setMode(b.textContent.toLowerCase()));
  setMode("send");
  return () => { if (teardown) teardown(); };
}

function renderManualSend(host) {
  const session = newSessionId();
  const fileInput = el("input", { type: "file" });
  const fileInfo = el("div", { class: "kv", style: { marginTop: "8px" } }, "No file selected.");

  const offerArea = el("textarea", { readonly: true, rows: 6, placeholder: "Offer will appear here…" });
  const copyOffer = el("button", { class: "primary" }, "Copy offer");

  const answerArea = el("textarea", { rows: 6, placeholder: "Paste answer here…" });
  const applyBtn = el("button", { class: "primary" }, "Apply answer");

  const stateBig = el("div", { class: "big-state" }, "Idle");
  const progress = el("div", { class: "progress" }, el("div"));
  const progressLine = el("div", { class: "kv" }, "—");
  const log = el("div", { class: "log" });
  const logFn = logger(log);

  let pc = null;
  let channel = null;
  let file = null;

  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "1 · File"), fileInput, fileInfo,
    el("p", { class: "kv", style: { marginTop: "8px" } }, "Session: " + session)
  ));
  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "2 · Copy this offer"), offerArea,
    el("div", { class: "btn-group", style: { marginTop: "8px" } }, copyOffer)
  ));
  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "3 · Paste their answer"), answerArea,
    el("div", { class: "btn-group", style: { marginTop: "8px" } }, applyBtn)
  ));
  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "4 · Transfer"), stateBig, progress, progressLine, log
  ));

  copyOffer.addEventListener("click", () => copyText(offerArea.value).then(() => toast("Copied")));
  fileInput.addEventListener("change", async () => {
    file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileInfo.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    if (pc) try { pc.close(); } catch {}
    pc = createPeer();
    channel = pc.createDataChannel("thinair-file", { ordered: true });
    watchConnection(pc, (s) => logFn(`pc: ${s.connection} / ${s.ice}`));
    channel.addEventListener("open", async () => {
      stateBig.textContent = "Sending";
      try {
        await sendFile(channel, file, (sent, total) => {
          const pct = total ? sent / total * 100 : 0;
          progress.firstElementChild.style.width = pct.toFixed(1) + "%";
          progressLine.textContent = `${fmtBytes(sent)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`;
        });
        stateBig.textContent = "Complete";
        progress.classList.add("ok");
      } catch (e) {
        stateBig.textContent = "Failed: " + e.message;
      }
    });
    stateBig.textContent = "Building offer";
    const desc = await createOffer(pc);
    const env = makeOfferEnvelope(desc.sdp, session);
    offerArea.value = envelopeToString(env);
    stateBig.textContent = "Waiting for answer";
  });

  applyBtn.addEventListener("click", async () => {
    if (!pc) { logFn("No peer yet — pick a file first"); return; }
    try {
      const ans = parsePayload(answerArea.value);
      if (ans.type !== "answer") throw new Error("not an answer");
      stateBig.textContent = "Applying answer";
      await applyAnswer(pc, { type: "answer", sdp: ans.sdp });
    } catch (e) {
      stateBig.textContent = "Bad answer: " + e.message;
    }
  });

  return () => {
    if (channel) try { channel.close(); } catch {}
    if (pc) try { pc.close(); } catch {}
  };
}

function renderManualReceive(host) {
  const offerArea = el("textarea", { rows: 6, placeholder: "Paste offer here…" });
  const buildBtn = el("button", { class: "primary" }, "Build answer");
  const answerArea = el("textarea", { readonly: true, rows: 6, placeholder: "Answer will appear here…" });
  const copyAns = el("button", { class: "primary" }, "Copy answer");

  const stateBig = el("div", { class: "big-state" }, "Waiting for offer");
  const fileLine = el("div", { class: "kv" }, "—");
  const progress = el("div", { class: "progress" }, el("div"));
  const progressLine = el("div", { class: "kv" }, "—");
  const log = el("div", { class: "log" });
  const logFn = logger(log);

  let pc = null;

  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "1 · Paste their offer"), offerArea,
    el("div", { class: "btn-group", style: { marginTop: "8px" } }, buildBtn)
  ));
  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "2 · Copy this answer"), answerArea,
    el("div", { class: "btn-group", style: { marginTop: "8px" } }, copyAns)
  ));
  host.appendChild(el("div", { class: "panel" },
    el("h3", {}, "3 · Transfer"), stateBig, fileLine, progress, progressLine, log
  ));

  copyAns.addEventListener("click", () => copyText(answerArea.value).then(() => toast("Copied")));

  buildBtn.addEventListener("click", async () => {
    try {
      const off = parsePayload(offerArea.value);
      if (off.type !== "offer") throw new Error("not an offer");
      if (pc) try { pc.close(); } catch {}
      pc = createPeer();
      pc.addEventListener("datachannel", (ev) => {
        const ch = ev.channel;
        ch.addEventListener("open", () => { stateBig.textContent = "Receiving"; logFn("DC open"); });
        receiveFile(ch,
          (rcv, total, meta) => {
            if (meta) fileLine.textContent = `${meta.name} · ${fmtBytes(meta.size)}`;
            const pct = total ? rcv / total * 100 : 0;
            progress.firstElementChild.style.width = pct.toFixed(1) + "%";
            progressLine.textContent = `${fmtBytes(rcv)} / ${fmtBytes(total)} (${pct.toFixed(1)}%)`;
          },
          (blob, meta) => {
            stateBig.textContent = "Complete";
            progress.classList.add("ok");
            downloadBlob(blob, meta.name);
          },
          (err) => { stateBig.textContent = "Failed: " + err.message; }
        );
      });
      watchConnection(pc, (s) => logFn(`pc: ${s.connection} / ${s.ice}`));
      stateBig.textContent = "Building answer";
      const desc = await createAnswer(pc, { type: "offer", sdp: off.sdp });
      const env = makeAnswerEnvelope(desc.sdp, off.id || "thinair");
      answerArea.value = envelopeToString(env);
      stateBig.textContent = "Send this answer back";
    } catch (e) {
      stateBig.textContent = "Bad offer: " + e.message;
    }
  });

  return () => {
    if (pc) try { pc.close(); } catch {}
  };
}
