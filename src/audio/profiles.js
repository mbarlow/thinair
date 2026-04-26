// Audio profiles. v1 uses 16-FSK across audible band.
// Frequencies chosen with non-harmonic spacing to reduce overlap from speaker harmonics.

export const PROFILES = {
  "birdsong-v1": {
    name: "birdsong-v1",
    mode: "audible",
    symbolMs: 60,
    gapMs: 12,
    preambleMs: 60,
    repeat: 3,
    payloadBytesPerFrame: 32,
    minHz: 1500,
    maxHz: 4500,
    // 16 data tones, log-spaced
    tones: logSpaced(1500, 4500, 16),
    // Distinct preamble tones (outside data band)
    preambleTones: [1100, 4900, 1100, 4900],
    envelope: "soft",
  },
  "modem-v1": {
    name: "modem-v1",
    mode: "audible",
    symbolMs: 50,
    gapMs: 8,
    preambleMs: 50,
    repeat: 3,
    payloadBytesPerFrame: 32,
    minHz: 1200,
    maxHz: 3600,
    tones: linSpaced(1200, 3600, 16),
    preambleTones: [900, 4000, 900, 4000],
    envelope: "hard",
  },
  "diagnostic-v1": {
    name: "diagnostic-v1",
    mode: "audible",
    symbolMs: 120,
    gapMs: 20,
    preambleMs: 120,
    repeat: 2,
    payloadBytesPerFrame: 16,
    minHz: 1500,
    maxHz: 4500,
    tones: logSpaced(1500, 4500, 16),
    preambleTones: [1100, 4900, 1100, 4900],
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
