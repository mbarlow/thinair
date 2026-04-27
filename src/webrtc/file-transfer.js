// File transfer protocol over a single ordered RTCDataChannel.
// Messages: JSON (batch-meta / file-meta / done / cancel) and binary chunks.
//
// Multi-file:
//   1. Sender sends batch-meta { kind:'batch', count, totalBytes }.
//   2. For each file i: file-meta { kind:'meta', i, name, type, size, chunkSize },
//      then binary chunks, then { kind:'file-done' }.
//   3. After last file, { kind:'done' }.

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATERMARK = 8 * 1024 * 1024;
const LOW_WATERMARK = 1 * 1024 * 1024;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function setupChannel(channel) {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = LOW_WATERMARK;
}

// files: File[] (single-file legacy callers can pass [file]).
export async function sendFiles(channel, files, callbacks = {}) {
  const { onBatch, onFileStart, onChunk, onFileDone, onComplete, isCancelled } = callbacks;
  setupChannel(channel);
  let totalBytes = 0;
  for (const f of files) totalBytes += f.size;
  channel.send(JSON.stringify({ kind: "batch", count: files.length, totalBytes }));
  if (onBatch) onBatch({ count: files.length, totalBytes });

  let bytesSent = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (isCancelled && isCancelled()) break;
    const meta = {
      kind: "meta",
      i,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      chunkSize: CHUNK_SIZE,
    };
    channel.send(JSON.stringify(meta));
    if (onFileStart) onFileStart({ index: i, file });

    let fileSent = 0;
    for (let off = 0; off < file.size; off += CHUNK_SIZE) {
      if (isCancelled && isCancelled()) break;
      if (channel.readyState !== "open") throw new Error("channel closed");
      while (channel.bufferedAmount > HIGH_WATERMARK) {
        await new Promise((resolve) => {
          const onLow = () => {
            channel.removeEventListener("bufferedamountlow", onLow);
            resolve();
          };
          channel.addEventListener("bufferedamountlow", onLow);
          setTimeout(onLow, 200);
        });
      }
      const slice = file.slice(off, off + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      channel.send(buf);
      fileSent += buf.byteLength;
      bytesSent += buf.byteLength;
      if (onChunk) onChunk({ index: i, file, fileSent, fileSize: file.size, bytesSent, totalBytes });
    }
    channel.send(JSON.stringify({ kind: "file-done", i }));
    if (onFileDone) onFileDone({ index: i, file });
  }
  channel.send(JSON.stringify({ kind: "done" }));
  while (channel.bufferedAmount > 0 && channel.readyState === "open") {
    await wait(20);
  }
  if (onComplete) onComplete();
}

// Backwards-compat single-file helper.
export async function sendFile(channel, file, onProgress) {
  return sendFiles(channel, [file], {
    onChunk: ({ fileSent, fileSize }) => onProgress && onProgress(fileSent, fileSize),
  });
}

export function receiveFiles(channel, callbacks = {}) {
  const { onBatch, onFileStart, onChunk, onFileDone, onComplete, onError } = callbacks;
  setupChannel(channel);
  let batch = null;
  let currentMeta = null;
  let currentChunks = [];
  let currentReceived = 0;
  let totalReceived = 0;

  const onMsg = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind === "batch") {
          batch = { count: m.count, totalBytes: m.totalBytes };
          if (onBatch) onBatch(batch);
        } else if (m.kind === "meta") {
          currentMeta = m;
          currentChunks = [];
          currentReceived = 0;
          if (onFileStart) onFileStart({ index: m.i, meta: m, batch });
        } else if (m.kind === "file-done") {
          if (currentMeta) {
            const blob = new Blob(currentChunks, { type: currentMeta.type });
            const finishedMeta = currentMeta;
            currentChunks = [];
            currentMeta = null;
            if (onFileDone) onFileDone({ index: finishedMeta.i, meta: finishedMeta, blob, batch });
          }
        } else if (m.kind === "done") {
          channel.removeEventListener("message", onMsg);
          if (onComplete) onComplete({ batch, totalReceived });
        } else if (m.kind === "cancel") {
          channel.removeEventListener("message", onMsg);
          if (onError) onError(new Error("sender cancelled"));
        }
      } catch (e) {
        if (onError) onError(e);
      }
    } else if (ev.data instanceof ArrayBuffer) {
      if (!currentMeta) return;
      currentChunks.push(ev.data);
      currentReceived += ev.data.byteLength;
      totalReceived += ev.data.byteLength;
      if (onChunk) onChunk({
        index: currentMeta.i,
        meta: currentMeta,
        fileReceived: currentReceived,
        fileSize: currentMeta.size,
        totalReceived,
        batch,
      });
    }
  };
  channel.addEventListener("message", onMsg);
  return () => channel.removeEventListener("message", onMsg);
}

// Backwards-compat single-file receiver.
export function receiveFile(channel, onProgress, onComplete, onError) {
  return receiveFiles(channel, {
    onChunk: ({ fileReceived, fileSize, meta }) => onProgress && onProgress(fileReceived, fileSize, meta),
    onFileDone: ({ blob, meta }) => onComplete && onComplete(blob, meta),
    onError,
  });
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
