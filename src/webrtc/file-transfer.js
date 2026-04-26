// File transfer protocol over a single ordered RTCDataChannel.
// Messages: JSON (meta/done/cancel) and binary (chunks).

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATERMARK = 8 * 1024 * 1024;
const LOW_WATERMARK = 1 * 1024 * 1024;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function setupChannel(channel) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = LOW_WATERMARK;
}

export async function sendFile(channel, file, onProgress) {
  setupChannel(channel);
  const meta = {
    kind: "meta",
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    chunkSize: CHUNK_SIZE,
  };
  channel.send(JSON.stringify(meta));

  let sent = 0;
  const total = file.size;
  let cancelled = false;
  const onMsg = (ev) => {
    try {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      if (m && m.kind === "cancel") cancelled = true;
    } catch {}
  };
  channel.addEventListener("message", onMsg);

  for (let offset = 0; offset < total && !cancelled; offset += CHUNK_SIZE) {
    if (channel.readyState !== "open") throw new Error("channel closed");
    while (channel.bufferedAmount > HIGH_WATERMARK) {
      await new Promise((resolve) => {
        const onLow = () => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        channel.addEventListener("bufferedamountlow", onLow);
        // safety
        setTimeout(onLow, 200);
      });
    }
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buf = await slice.arrayBuffer();
    channel.send(buf);
    sent += buf.byteLength;
    if (onProgress) onProgress(sent, total);
  }

  channel.removeEventListener("message", onMsg);
  if (cancelled) {
    channel.send(JSON.stringify({ kind: "cancel" }));
    throw new Error("cancelled by remote");
  }
  channel.send(JSON.stringify({ kind: "done" }));
  // wait for buffered bytes to drain
  while (channel.bufferedAmount > 0 && channel.readyState === "open") {
    await wait(20);
  }
}

export function receiveFile(channel, onProgress, onComplete, onError) {
  setupChannel(channel);
  let meta = null;
  let chunks = [];
  let received = 0;

  const onMsg = async (ev) => {
    if (typeof ev.data === "string") {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind === "meta") {
          meta = m;
          chunks = [];
          received = 0;
          if (onProgress) onProgress(0, meta.size, meta);
        } else if (m.kind === "done") {
          if (!meta) return;
          const blob = new Blob(chunks, { type: meta.type });
          chunks = [];
          channel.removeEventListener("message", onMsg);
          if (onComplete) onComplete(blob, meta);
        } else if (m.kind === "cancel") {
          channel.removeEventListener("message", onMsg);
          if (onError) onError(new Error("sender cancelled"));
        }
      } catch (e) {
        if (onError) onError(e);
      }
    } else if (ev.data instanceof ArrayBuffer) {
      if (!meta) return;
      chunks.push(ev.data);
      received += ev.data.byteLength;
      if (onProgress) onProgress(received, meta.size, meta);
    }
  };
  channel.addEventListener("message", onMsg);

  return () => channel.removeEventListener("message", onMsg);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "thinair-file";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}
