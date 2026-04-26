// Audio profiles. v1 uses 16-FSK across audible band, with a sustained low-tone
// preamble for sample-accurate sync.

export const PROFILES = {
  "birdsong-v1": {
    name: "birdsong-v1",
    mode: "audible",
    symbolMs: 60,
    gapMs: 12,
    repeat: 3,
    payloadBytesPerFrame: 32,
    minHz: 1500,
    maxHz: 4500,
    tones: logSpaced(1500, 4500, 16),
    syncHz: 800,
    syncMs: 250,
    syncGapMs: 50,
    envelope: "soft",
  },
  "modem-v1": {
    name: "modem-v1",
    mode: "audible",
    symbolMs: 50,
    gapMs: 8,
    repeat: 3,
    payloadBytesPerFrame: 32,
    minHz: 1200,
    maxHz: 3600,
    tones: linSpaced(1200, 3600, 16),
    syncHz: 600,
    syncMs: 200,
    syncGapMs: 40,
    envelope: "hard",
  },
  "diagnostic-v1": {
    name: "diagnostic-v1",
    mode: "audible",
    symbolMs: 140,
    gapMs: 30,
    repeat: 2,
    payloadBytesPerFrame: 8,
    minHz: 1500,
    maxHz: 4500,
    tones: logSpaced(1500, 4500, 8).concat(logSpaced(1500, 4500, 16).slice(8)),
    syncHz: 800,
    syncMs: 400,
    syncGapMs: 100,
    envelope: "soft",
  },
};

function logSpaced(lo, hi, n) {
  const out = [];
  const a = Math.log(lo);
  const b = Math.log(hi);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(Math.round(Math.exp(a + (b - a) * t)));
  }
  return out;
}

function linSpaced(lo, hi, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(lo + (hi - lo) * i / (n - 1)));
  return out;
}

export function getProfile(name) {
  return PROFILES[name] || PROFILES["birdsong-v1"];
}
