// Audio profiles. v3 uses 4 parallel sub-bands × 4-FSK each = 1 byte per
// symbol slot. Sustained-tone preamble for sample-accurate sync.

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
    bands: [
      [1500, 1700, 1900, 2100],
      [2300, 2500, 2700, 2900],
      [3100, 3300, 3500, 3700],
      [3900, 4100, 4300, 4500],
    ],
    sweepStartHz: 800,
    sweepEndHz: 4800,
    sweepMs: 150,
    sweepGapMs: 50,
    envelope: "soft",
    perToneAmplitude: 0.22,
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
    bands: [
      [1200, 1380, 1560, 1740],
      [1920, 2100, 2280, 2460],
      [2640, 2820, 3000, 3180],
      [3360, 3540, 3720, 3900],
    ],
    sweepStartHz: 600,
    sweepEndHz: 4000,
    sweepMs: 120,
    sweepGapMs: 40,
    envelope: "hard",
    perToneAmplitude: 0.22,
  },
  "diagnostic-v1": {
    name: "diagnostic-v1",
    mode: "audible",
    symbolMs: 140,
    gapMs: 30,
    repeat: 2,
    payloadBytesPerFrame: 16,
    minHz: 1500,
    maxHz: 4500,
    bands: [
      [1500, 1750, 2000, 2250],
      [2500, 2750, 3000, 3250],
      [3500, 3750, 4000, 4250],
      [4500, 4750, 5000, 5250],
    ],
    sweepStartHz: 700,
    sweepEndHz: 5000,
    sweepMs: 250,
    sweepGapMs: 100,
    envelope: "soft",
    perToneAmplitude: 0.22,
  },
};

export function getProfile(name) {
  return PROFILES[name] || PROFILES["birdsong-v1"];
}
