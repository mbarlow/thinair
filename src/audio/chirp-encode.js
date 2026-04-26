// FSK encoder. Builds an AudioBuffer from a sequence of frame bytes.
// Each byte = 2 nibbles = 2 symbols. Each symbol = one tone from the 16-tone alphabet.
// Frames are separated by gap silence and prefixed with a preamble pattern.

import { getProfile } from "./profiles.js";
import { buildFrames, sessionStringTo16 } from "./framing.js";

function applyEnvelope(samples, sampleRate, envelopeKind) {
  const fadeMs = envelopeKind === "soft" ? 8 : 2;
  const fadeSamples = Math.min(samples.length / 4, Math.floor((fadeMs / 1000) * sampleRate));
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples;
    const w = 0.5 * (1 - Math.cos(Math.PI * t)); // Hann
    samples[i] *= w;
    samples[samples.length - 1 - i] *= w;
  }
}

function fillTone(samples, offset, count, freq, sampleRate, amplitude, envelope) {
  const buf = new Float32Array(count);
  const omega = 2 * Math.PI * freq / sampleRate;
  for (let i = 0; i < count; i++) buf[i] = amplitude * Math.sin(omega * i);
  applyEnvelope(buf, sampleRate, envelope);
  samples.set(buf, offset);
}

export function encodeFramesToAudioBuffer(audioCtx, frames, profile) {
  const sr = audioCtx.sampleRate;
  const symbolSamples = Math.floor(profile.symbolMs / 1000 * sr);
  const syncSamples = Math.floor(profile.syncMs / 1000 * sr);
  const syncGapSamples = Math.floor(profile.syncGapMs / 1000 * sr);
  const interFrameGap = Math.floor(profile.symbolMs * 4 / 1000 * sr);

  // Each frame: sync tone + silence + (frameBytes.length * 2) symbols + inter-frame gap
  let totalSamples = 0;
  for (const f of frames) {
    totalSamples += syncSamples + syncGapSamples + f.length * 2 * symbolSamples + interFrameGap;
  }

  const buffer = audioCtx.createBuffer(1, Math.max(1, totalSamples), sr);
  const out = buffer.getChannelData(0);

  let off = 0;
  const amp = 0.6;
  for (const f of frames) {
    // Sustained sync tone — the receiver locks the symbol grid on its trailing edge.
    fillTone(out, off, syncSamples, profile.syncHz, sr, amp, profile.envelope);
    off += syncSamples;
    // Silence gap — clean falling edge for sync detection, no symbol grid pollution.
    off += syncGapSamples;
    // Data symbols, two per byte (high nibble first).
    for (let i = 0; i < f.length; i++) {
      const hi = (f[i] >> 4) & 0x0f;
      const lo = f[i] & 0x0f;
      fillTone(out, off, symbolSamples, profile.tones[hi], sr, amp, profile.envelope);
      off += symbolSamples;
      fillTone(out, off, symbolSamples, profile.tones[lo], sr, amp, profile.envelope);
      off += symbolSamples;
    }
    off += interFrameGap;
  }
  return buffer;
}

export function buildChirpForPayload(audioCtx, payloadBytes, sessionStr, profileName) {
  const profile = getProfile(profileName);
  const frames = buildFrames(payloadBytes, sessionStringTo16(sessionStr), profile.payloadBytesPerFrame);
  const buffer = encodeFramesToAudioBuffer(audioCtx, frames, profile);
  return { buffer, profile, frames };
}

export class ChirpPlayer {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.source = null;
    this.gain = audioCtx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(audioCtx.destination);
    this.playing = false;
    this.repeats = 0;
    this.maxRepeats = 0;
    this.buffer = null;
    this.onCycle = null;
    this.onDone = null;
  }

  play(buffer, repeats = 3, onCycle, onDone) {
    this.stop();
    this.buffer = buffer;
    this.repeats = 0;
    this.maxRepeats = repeats;
    this.onCycle = onCycle;
    this.onDone = onDone;
    this.playing = true;
    this._playOne();
  }

  _playOne() {
    if (!this.playing || !this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      this.repeats++;
      if (this.onCycle) this.onCycle(this.repeats, this.maxRepeats);
      if (!this.playing) {
        if (this.onDone) this.onDone(false);
        return;
      }
      if (this.repeats >= this.maxRepeats) {
        this.playing = false;
        this.source = null;
        if (this.onDone) this.onDone(true);
        return;
      }
      // small inter-cycle pause
      setTimeout(() => this._playOne(), 250);
    };
    this.source = src;
    src.start();
  }

  stop() {
    this.playing = false;
    if (this.source) {
      try { this.source.stop(); } catch {}
      this.source = null;
    }
  }
}
