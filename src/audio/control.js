// Control messages exchanged over the chirp protocol on top of the same FSK
// modem and frame format. The first byte of a control payload identifies the
// type: 'N' = NACK with missing-frame list, 'A' = ACK = whole payload received.

export const CONTROL_NACK = 0x4E; // 'N'
export const CONTROL_ACK = 0x41;  // 'A'

export function buildNackPayload(total, missingArr) {
  let m = missingArr;
  if (m.length > 240) m = m.slice(0, 240);
  const buf = new Uint8Array(3 + m.length);
  buf[0] = CONTROL_NACK;
  buf[1] = total & 0xff;
  buf[2] = m.length;
  for (let i = 0; i < m.length; i++) buf[3 + i] = m[i] & 0xff;
  return buf;
}

export function buildAckPayload(total) {
  return new Uint8Array([CONTROL_ACK, total & 0xff]);
}

export function parseControl(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const t = bytes[0];
  if (t === CONTROL_NACK) {
    if (bytes.length < 3) return null;
    const total = bytes[1];
    const cnt = bytes[2];
    if (bytes.length < 3 + cnt) return null;
    return {
      kind: "nack",
      total,
      missing: Array.from(bytes.subarray(3, 3 + cnt)),
    };
  }
  if (t === CONTROL_ACK) {
    return { kind: "ack", total: bytes[1] };
  }
  return null;
}
