// CRC-16/CCITT-FALSE
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    t[i] = c;
  }
  return t;
})();

export function crc16(bytes, init = 0xffff) {
  let c = init;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC16_TABLE[((c >> 8) ^ bytes[i]) & 0xff] ^ (c << 8)) & 0xffff;
  }
  return c;
}

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s;
}
