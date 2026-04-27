// Multi-tone FSK encoder. One symbol slot carries one byte, encoded as 4
// simultaneous tones — one from each of 4 sub-bands (4-FSK per band).

import { getProfile } from "./profiles.js";
import { buildFrames, sessionStringTo16 } from "./framing.js";

function applyEnvelope(samples, sampleRate, envelopeKind) {
  const fadeMs = envelopeKind === "soft" ? 8 : 2;
  const fadeSamples = Math.min(samples.length / 4, Math.floor((fadeMs / 1000) * sampleRate));
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples;
    const w = 0.5 * (1 - Math.cos(Math.PI * t));
    samples[i] *= w;
    samples[samples.length - 1 - i] *= w;
  }
}

function fillSingleTone(samples, offset, count, freq, sampleRate, amplitude, envelope) {
  const buf = new Float32Array(count);
  const omega = 2 * Math.PI * freq / sampleRate;
  for (let i = 0; i < count; i++) buf[i] = amplitude * Math.sin(omega * i);
  applyEnvelope(buf, sampleRate, envelope);
  samples.set(buf, offset);
}

// Linear-FM sweep from f0 to f1 over `count` samples. Used as the preamble.
// The receiver runs an I/Q matched filter against an identical template,
// giving sample-accurate symbol-grid alignment.
export function fillChirpSweep(samples, offset, count, f0, f1, sampleRate, amplitude, envelope) {
  const buf = new Float32Array(count);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const f = f0 + (f1 - f0) * t;
    phase += 2 * Math.PI * f / sampleRate;
    buf[i] = amplitude * Math.sin(phase);
  }
  applyEnvelope(buf, sampleRate, envelope);
  samples.set(buf, offset);
}

// Generate the I and Q (cos/sin) reference templates the decoder uses for
// matched-filter correlation. Identical phase trajectory to fillChirpSweep.
export function makeSweepTemplates(count, f0, f1, sampleRate) {
  const i = new Float32Array(count);
  const q = new Float32Array(count);
  let phase = 0;
  for (let n = 0; n < count; n++) {
    const t = n / count;
    const f = f0 + (f1 - f0) * t;
    phase += 2 * Math.PI * f / sampleRate;
    i[n] = Math.cos(phase);
    q[n] = Math.sin(phase);
  }
  // Normalize energy.
  let e = 0;
  for (let n = 0; n < count; n++) e += i[n] * i[n] + q[n] * q[n];
  const k = 1 / Math.sqrt(e);
  for (let n = 0; n < count; n++) { i[n] *= k; q[n] *= k; }
  return { i, q };
}

function fillMultiTone(samples, offset, count, freqs, sampleRate, perToneAmp, envelope) {
  const buf = new Float32Array(count);
  const omegas = freqs.map((f) => 2 * Math.PI * f / sampleRate);
  for (let i = 0; i < count; i++) {
    let s = 0;
    for (let j = 0; j < omegas.length; j++) s += perToneAmp * Math.sin(omegas[j] * i);
    buf[i] = s;
  }
  applyEnvelope(buf, sampleRate, envelope);
  samples.set(buf, offset);
}

export function encodeFramesToAudioBuffer(audioCtx, frames, profile) {
  const sr = audioCtx.sampleRate;
  const symbolSamples = Math.floor(profile.symbolMs / 1000 * sr);
  const sweepSamples = Math.floor(profile.sweepMs / 1000 * sr);
  const sweepGapSamples = Math.floor(profile.sweepGapMs / 1000 * sr);
  const interFrameGap = Math.floor(profile.symbolMs * 4 / 1000 * sr);

  let totalSamples = 0;
  for (const f of frames) {
    totalSamples += sweepSamples + sweepGapSamples + f.length * symbolSamples + interFrameGap;
  }

  const buffer = audioCtx.createBuffer(1, Math.max(1, totalSamples), sr);
  const out = buffer.getChannelData(0);

  let off = 0;
  const sweepAmp = 0.55;
  const perTone = profile.perToneAmplitude || 0.22;
  for (const f of frames) {
    fillChirpSweep(out, off, sweepSamples, profile.sweepStartHz, profile.sweepEndHz, sr, sweepAmp, profile.envelope);
    off += sweepSamples;
    off += sweepGapSamples; // silence between preamble and data
    for (let i = 0; i < f.length; i++) {
      const b = f[i];
      const i0 = (b >> 6) & 0x3;
      const i1 = (b >> 4) & 0x3;
      const i2 = (b >> 2) & 0x3;
      const i3 = b & 0x3;
      const freqs = [
        profile.bands[0][i0],
        profile.bands[1][i1],
        profile.bands[2][i2],
        profile.bands[3][i3],
      ];
      fillMultiTone(out, off, symbolSamples, freqs, sr, perTone, profile.envelope);
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

// Build an AudioBuffer that only plays the requested 1-based frame numbers
// from a previously-built frame array. Used by NACK retransmission: the
// receiver tells the sender which frames are missing, the sender replays
// just those (each frame still carries its real seq/total in its header).
export function buildPartialChirp(audioCtx, allFrames, missingIndices, profileName) {
  const profile = getProfile(profileName);
  const subset = [];
  for (const idx of missingIndices) {
    const f = allFrames[idx - 1];
    if (f) subset.push(f);
  }
  if (!subset.length) return null;
  const buffer = encodeFramesToAudioBuffer(audioCtx, subset, profile);
  return { buffer, profile, frames: subset };
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
