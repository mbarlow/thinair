// Pack/unpack a minimal SDP into compact binary by extracting only the dynamic
// fields (ufrag, pwd, fingerprint, setup, mid, candidates, sessionId) and
// rebuilding the rest from a fixed template at the receiver.
//
// Saves ~70% over raw SDP — typical Chrome data-channel offer of 720 bytes
// packs to ~180 bytes. Combined with base64url for QR/text or raw bytes for
// audio, transmission shrinks ~3-4x.

const ENV_MAGIC = 0xC1;
const ENV_VERSION = 0x01;
const TYPE_OFFER = 0;
const TYPE_ANSWER = 1;
const SETUP_MAP = { actpass: 0, active: 1, passive: 2 };
const SETUP_REVERSE = ["actpass", "active", "passive"];
const CTYPE_MAP = { host: 0, srflx: 1, prflx: 2, relay: 3 };
const CTYPE_REVERSE = ["host", "srflx", "prflx", "relay"];

export function isPackedEnvelope(bytes) {
  return bytes && bytes.length >= 4 && bytes[0] === ENV_MAGIC && bytes[1] === ENV_VERSION;
}

export function packSDP(sdpStr, sdpType, sessionId) {
  const lines = sdpStr.split(/\r?\n/);
  let ufrag = "", pwd = "", fingerprintHex = "", setup = "actpass", mid = "0";
  const candidates = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("a=ice-ufrag:")) ufrag = line.slice(12);
    else if (line.startsWith("a=ice-pwd:")) pwd = line.slice(10);
    else if (line.startsWith("a=fingerprint:sha-256 ")) fingerprintHex = line.slice("a=fingerprint:sha-256 ".length);
    else if (line.startsWith("a=setup:")) setup = line.slice(8);
    else if (line.startsWith("a=mid:")) mid = line.slice(6);
    else if (line.startsWith("a=candidate:")) {
      const parts = line.slice("a=candidate:".length).split(/\s+/);
      // foundation, component, transport, priority, addr, port, "typ", type, [raddr X rport N] [generation N] [network-cost N] [network-id N] [tcptype X] ...
      const cand = {
        foundation: parts[0],
        component: parseInt(parts[1], 10) | 0,
        transport: (parts[2] || "udp").toLowerCase(),
        priority: parseInt(parts[3], 10) >>> 0,
        addr: parts[4],
        port: parseInt(parts[5], 10) | 0,
        type: parts[7],
      };
      let i = 8;
      while (i + 1 < parts.length) {
        const k = parts[i];
        if (k === "raddr") cand.raddr = parts[i + 1];
        else if (k === "rport") cand.rport = parseInt(parts[i + 1], 10) | 0;
        i += 2;
      }
      candidates.push(cand);
    }
  }
  if (!ufrag || !pwd || !fingerprintHex) {
    throw new Error("packSDP: missing ufrag/pwd/fingerprint");
  }
  const fpClean = fingerprintHex.replace(/:/g, "");
  if (fpClean.length !== 64) throw new Error("packSDP: bad fingerprint length");

  const out = [];
  const enc = new TextEncoder();
  const pushU8 = (n) => out.push(n & 0xff);
  const pushU16 = (n) => { out.push((n >> 8) & 0xff); out.push(n & 0xff); };
  const pushU32 = (n) => {
    out.push((n >>> 24) & 0xff); out.push((n >>> 16) & 0xff);
    out.push((n >>> 8) & 0xff); out.push(n & 0xff);
  };
  const pushStr = (s) => {
    const b = enc.encode(s);
    if (b.length > 255) throw new Error("packSDP: string too long: " + s.slice(0, 40));
    pushU8(b.length);
    for (const c of b) out.push(c);
  };

  pushU8(ENV_MAGIC);
  pushU8(ENV_VERSION);
  pushU8(sdpType === "offer" ? TYPE_OFFER : TYPE_ANSWER);
  pushU8(SETUP_MAP[setup] != null ? SETUP_MAP[setup] : 0);
  pushStr(sessionId || "");
  pushStr(mid);
  pushStr(ufrag);
  pushStr(pwd);
  // 32-byte raw fingerprint
  for (let i = 0; i < 32; i++) out.push(parseInt(fpClean.slice(i * 2, i * 2 + 2), 16));

  pushU8(candidates.length);
  for (const c of candidates) {
    pushStr(c.foundation);
    pushU8(c.component);
    pushU8(c.transport === "tcp" ? 1 : 0);
    pushU32(c.priority);
    pushStr(c.addr);
    pushU16(c.port);
    pushU8(CTYPE_MAP[c.type] != null ? CTYPE_MAP[c.type] : 0);
    if (c.raddr != null) {
      pushU8(1);
      pushStr(c.raddr);
      pushU16((c.rport || 0) & 0xffff);
    } else {
      pushU8(0);
    }
  }
  return new Uint8Array(out);
}

export function unpackSDP(bytes) {
  let i = 0;
  if (bytes[i++] !== ENV_MAGIC) throw new Error("unpackSDP: bad magic");
  const version = bytes[i++];
  if (version !== ENV_VERSION) throw new Error("unpackSDP: unknown version " + version);
  const type = bytes[i++] === TYPE_OFFER ? "offer" : "answer";
  const setup = SETUP_REVERSE[bytes[i++]] || "actpass";
  const dec = new TextDecoder();

  function readStr() {
    const n = bytes[i++];
    const s = dec.decode(bytes.subarray(i, i + n));
    i += n;
    return s;
  }
  function readU16() { const v = (bytes[i] << 8) | bytes[i + 1]; i += 2; return v; }
  function readU32() {
    const v = ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
    i += 4; return v;
  }

  const sessionId = readStr();
  const mid = readStr();
  const ufrag = readStr();
  const pwd = readStr();
  const fpParts = [];
  for (let j = 0; j < 32; j++) fpParts.push(bytes[i++].toString(16).padStart(2, "0").toUpperCase());
  const fingerprint = fpParts.join(":");

  const cn = bytes[i++];
  const candidates = [];
  for (let j = 0; j < cn; j++) {
    const foundation = readStr();
    const component = bytes[i++];
    const transport = bytes[i++] === 1 ? "tcp" : "udp";
    const priority = readU32();
    const addr = readStr();
    const port = readU16();
    const ctype = CTYPE_REVERSE[bytes[i++]] || "host";
    const hasR = bytes[i++];
    let raddr = null, rport = 0;
    if (hasR) { raddr = readStr(); rport = readU16(); }
    candidates.push({ foundation, component, transport, priority, addr, port, type: ctype, raddr, rport });
  }
  const sdp = buildSDP({ setup, mid, ufrag, pwd, fingerprint, candidates });
  return { type, sdp, id: sessionId };
}

function buildSDP({ setup, mid, ufrag, pwd, fingerprint, candidates }) {
  // Use a fresh session id; it only needs to be unique-ish.
  const sid = String(Math.floor(Math.random() * 9e15) + 1);
  const lines = [
    "v=0",
    `o=- ${sid} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mid}`,
    "a=extmap-allow-mixed",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
  ];
  for (const c of candidates) {
    let line = `a=candidate:${c.foundation} ${c.component} ${c.transport} ${c.priority >>> 0} ${c.addr} ${c.port} typ ${c.type}`;
    if (c.raddr) line += ` raddr ${c.raddr} rport ${c.rport}`;
    line += " generation 0";
    lines.push(line);
  }
  lines.push("a=end-of-candidates");
  lines.push(`a=ice-ufrag:${ufrag}`);
  lines.push(`a=ice-pwd:${pwd}`);
  lines.push("a=ice-options:trickle");
  lines.push(`a=fingerprint:sha-256 ${fingerprint}`);
  lines.push(`a=setup:${setup}`);
  lines.push(`a=mid:${mid}`);
  lines.push("a=sctp-port:5000");
  lines.push("a=max-message-size:262144");
  return lines.join("\r\n") + "\r\n";
}
