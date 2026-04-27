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
  const syncSamples = Math.floor(profile.syncMs / 1000 * sr);
  const syncGapSamples = Math.floor(profile.syncGapMs / 1000 * sr);
  const interFrameGap = Math.floor(profile.symbolMs * 4 / 1000 * sr);

  // 1 symbol per byte (was 2 nibbles). Per-frame length:
  // bytes: 7 header + payload + 2 crc = (9 + payload) bytes
  let totalSamples = 0;
  for (const f of frames) {
    totalSamples += syncSamples + syncGapSamples + f.length * symbolSamples + interFrameGap;
  }

  const buffer = audioCtx.createBuffer(1, Math.max(1, totalSamples), sr);
  const out = buffer.getChannelData(0);

  let off = 0;
  const syncAmp = 0.55;
  const perTone = profile.perToneAmplitude || 0.22;
  for (const f of frames) {
    fillSingleTone(out, off, syncSamples, profile.syncHz, sr, syncAmp, profile.envelope);
    off += syncSamples;
    off += syncGapSamples; // silence
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
