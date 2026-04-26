// Framing for chirp transport. Splits a payload byte array into frames.
// Frame layout (no preamble; preamble is added by encoder):
//   magic:1 (0xAA), version:1 (0x01), sessionLo:1, sessionHi:1,
//   seq:1, total:1, payloadLen:1, payload:N, crc16:2 (BE)
// Total: 8 + N bytes. Header is 7 bytes; CRC covers bytes 0..(7+N-1).
import { crc16 } from "../codec/checksum.js";

export const MAGIC = 0xAA;
export const VERSION = 0x01;

export function sessionStringTo16(s) {
  // Stable 16-bit hash (FNV-1a, truncated)
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h & 0xffff;
}

export function buildFrames(payloadBytes, sessionId16, payloadBytesPerFrame) {
  const frames = [];
  const total = Math.max(1, Math.ceil(payloadBytes.length / payloadBytesPerFrame));
  if (total > 255) throw new Error("payload too large for chirp framing");
  for (let i = 0; i < total; i++) {
    const slice = payloadBytes.slice(i * payloadBytesPerFrame, (i + 1) * payloadBytesPerFrame);
    const len = slice.length;
    const buf = new Uint8Array(7 + len + 2);
    buf[0] = MAGIC;
    buf[1] = VERSION;
    buf[2] = sessionId16 & 0xff;
    buf[3] = (sessionId16 >> 8) & 0xff;
    buf[4] = i + 1; // seq 1-based
    buf[5] = total;
    buf[6] = len;
    buf.set(slice, 7);
    const c = crc16(buf.subarray(0, 7 + len));
    buf[7 + len] = (c >> 8) & 0xff;
    buf[7 + len + 1] = c & 0xff;
    frames.push(buf);
  }
  return frames;
}

export function parseFrame(buf) {
  if (buf.length < 9) return null;
  if (buf[0] !== MAGIC) return null;
  if (buf[1] !== VERSION) return null;
  const session = buf[2] | (buf[3] << 8);
  const seq = buf[4];
  const total = buf[5];
  const len = buf[6];
  if (buf.length < 9 + len) return null;
  const expectedCrc = (buf[7 + len] << 8) | buf[7 + len + 1];
  const calcCrc = crc16(buf.subarray(0, 7 + len));
  if (expectedCrc !== calcCrc) return null;
  return {
    session, seq, total,
    payload: buf.subarray(7, 7 + len),
    rawLength: 9 + len,
  };
}

// Reassemble frames into the full payload. Returns Uint8Array or null if incomplete.
export class FrameAssembler {
  constructor(expectedSession = null) {
    this.expectedSession = expectedSession;
    this.frames = new Map(); // seq -> Uint8Array(payload)
    this.total = null;
    this.session = null;
  }

  add(frame) {
    if (this.expectedSession != null && frame.session !== this.expectedSession) return false;
    if (this.session == null) this.session = frame.session;
    if (this.total == null) this.total = frame.total;
    if (frame.total !== this.total) return false;
    this.frames.set(frame.seq, frame.payload);
    return true;
  }

  haveCount() { return this.frames.size; }
  totalCount() { return this.total || 0; }
  missing() {
    const out = [];
    if (this.total == null) return out;
    for (let i = 1; i <= this.total; i++) if (!this.frames.has(i)) out.push(i);
    return out;
  }

  isComplete() { return this.total != null && this.frames.size === this.total; }

  assemble() {
    if (!this.isComplete()) return null;
    let len = 0;
    for (let i = 1; i <= this.total; i++) len += this.frames.get(i).length;
    const out = new Uint8Array(len);
    let off = 0;
    for (let i = 1; i <= this.total; i++) {
      const part = this.frames.get(i);
      out.set(part, off);
      off += part.length;
    }
    return out;
  }
}
