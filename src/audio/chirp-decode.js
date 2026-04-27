// Multi-band FSK decoder. Tracks energy at the sync tone, locks the symbol
// grid on the falling edge, then for each symbol reads 4 simultaneous tones —
// one per sub-band, 4-FSK each. Combines into 1 byte per symbol slot.

import { getProfile } from "./profiles.js";
import { parseFrame, FrameAssembler, MAGIC } from "./framing.js";

function goertzel(samples, off, len, k) {
  const omega = 2 * Math.PI * k;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = samples[off + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / len;
}

const STATE = {
  SEARCH: "search",
  IN_SYNC: "in-sync",
  LOCKED: "locked",
};

export class ChirpDecoder {
  constructor(profileName, opts = {}) {
    this.profile = getProfile(profileName);
    this.opts = opts;
    this.audioCtx = null;
    this.source = null;
    this.processor = null;
    this.stream = null;
    this.running = false;
    this.buf = null;
    this.bufWritePos = 0;
    this.bufFilled = 0;
    this.totalSamplesProcessed = 0;
    this.sampleRate = 0;
    this.symbolSamples = 0;
    this.syncWindowSamples = 0;
    this.searchHopSamples = 0;
    this.bandKs = null;       // [[k,k,k,k] x 4]
    this.syncK = 0;
    this.syncGapSamples = 0;
    this.bandLowK = 0;
    this.bandHighK = 0;
    this.state = STATE.SEARCH;
    this.frameBytes = [];
    this.frameTargetBytes = 0;
    this.symbolClock = 0;
    this.searchClock = 0;
    this.assembler = new FrameAssembler();
    this.noiseFloor = 1e-9;
    this.peakSync = 0;
    this.lastLevel = 0;
    this.onFrame = null;
    this.onSignal = null;
    this.onLevel = null;
  }

  async start({ onFrame, onSignal, onLevel }) {
    if (this.running) return;
    this.onFrame = onFrame;
    this.onSignal = onSignal;
    this.onLevel = onLevel;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
    this.sampleRate = this.audioCtx.sampleRate;

    this._initFromProfile();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      this._onSamples(ev.inputBuffer.getChannelData(0));
      ev.outputBuffer.getChannelData(0).fill(0);
    };
    this._sink = this.audioCtx.createGain();
    this._sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this._sink);
    this._sink.connect(this.audioCtx.destination);
    this.running = true;
  }

  _initFromProfile() {
    const sr = this.sampleRate;
    const p = this.profile;
    this.symbolSamples = Math.floor(p.symbolMs / 1000 * sr);
    this.syncWindowSamples = Math.max(256, Math.floor(0.030 * sr));
    this.searchHopSamples = Math.max(64, Math.floor(this.syncWindowSamples / 4));
    this.syncGapSamples = Math.floor(p.syncGapMs / 1000 * sr);
    this.bandKs = p.bands.map((band) => band.map((f) => f / sr));
    this.syncK = p.syncHz / sr;
    this.bandLowK = p.minHz / sr;
    this.bandHighK = p.maxHz / sr;
    const maxFrameBytes = (9 + 255);
    const maxFrameSamples = maxFrameBytes * this.symbolSamples;
    const minSyncSamples = Math.floor(p.syncMs / 1000 * sr) + this.syncGapSamples;
    const ringSize = Math.max(sr * 2, maxFrameSamples + minSyncSamples + sr);
    this.buf = new Float32Array(ringSize);
    this.bufWritePos = 0;
    this.bufFilled = 0;
    this.totalSamplesProcessed = 0;
    this.searchClock = 0;
    this.symbolClock = 0;
    this.state = STATE.SEARCH;
    this.frameBytes = [];
    this.frameTargetBytes = 0;
    this.peakSync = 0;
    this.noiseFloor = 1e-9;
  }

  stop() {
    this.running = false;
    try { if (this.processor) this.processor.disconnect(); } catch {}
    try { if (this._sink) this._sink.disconnect(); } catch {}
    try { if (this.source) this.source.disconnect(); } catch {}
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
  }

  reset() {
    this.assembler = new FrameAssembler();
    this.state = STATE.SEARCH;
    this.frameBytes = [];
    this.frameTargetBytes = 0;
    this.peakSync = 0;
  }

  _onSamples(input) {
    const len = input.length;
    let amp = 0;
    for (let i = 0; i < len; i++) amp += Math.abs(input[i]);
    this.lastLevel = amp / len;
    if (this.onLevel) this.onLevel(this.lastLevel);

    let wp = this.bufWritePos;
    if (wp + len <= this.buf.length) {
      this.buf.set(input, wp);
    } else {
      const first = this.buf.length - wp;
      this.buf.set(input.subarray(0, first), wp);
      this.buf.set(input.subarray(first), 0);
    }
    this.bufWritePos = (wp + len) % this.buf.length;
    this.bufFilled = Math.min(this.bufFilled + len, this.buf.length);
    this.totalSamplesProcessed += len;

    this._process();
  }

  _readWindow(endAbs, count) {
    if (this.totalSamplesProcessed < endAbs) return null;
    if (endAbs - count < this.totalSamplesProcessed - this.bufFilled) return null;
    const ringEnd = (this.bufWritePos - (this.totalSamplesProcessed - endAbs) + this.buf.length) % this.buf.length;
    const start = ((ringEnd - count) % this.buf.length + this.buf.length) % this.buf.length;
    if (start + count <= this.buf.length) {
      return this.buf.subarray(start, start + count);
    }
    const out = new Float32Array(count);
    const first = this.buf.length - start;
    out.set(this.buf.subarray(start, this.buf.length), 0);
    out.set(this.buf.subarray(0, count - first), first);
    return out;
  }

  // Decode one byte from a sample buffer: pick the strongest tone in each of
  // the 4 sub-bands (2 bits each), pack into a byte (band 0 = bits 7-6).
  _readByte(buf, off, len) {
    let byte = 0;
    let totalPow = 0;
    for (let bandIdx = 0; bandIdx < 4; bandIdx++) {
      const ks = this.bandKs[bandIdx];
      let bestI = 0;
      let bestPow = -1;
      for (let i = 0; i < ks.length; i++) {
        const p = goertzel(buf, off, len, ks[i]);
        if (p > bestPow) { bestPow = p; bestI = i; }
      }
      totalPow += bestPow;
      byte |= (bestI & 0x3) << ((3 - bandIdx) * 2);
    }
    return { byte, power: totalPow };
  }

  _process() {
    while (true) {
      if (this.state === STATE.SEARCH || this.state === STATE.IN_SYNC) {
        const wEnd = this.searchClock + this.syncWindowSamples;
        if (this.totalSamplesProcessed < wEnd) return;
        const w = this._readWindow(wEnd, this.syncWindowSamples);
        if (!w) { this.searchClock += this.searchHopSamples; continue; }
        const syncPow = goertzel(w, 0, w.length, this.syncK);
        const dataPow = goertzel(w, 0, w.length, (this.bandLowK + this.bandHighK) / 2);

        if (this.state === STATE.SEARCH) {
          if (syncPow < this.noiseFloor * 4 || this.noiseFloor < 1e-12) {
            this.noiseFloor = this.noiseFloor * 0.95 + syncPow * 0.05;
          }
          const threshHigh = Math.max(this.noiseFloor * 30, 1e-6);
          if (syncPow > threshHigh && syncPow > dataPow * 1.5) {
            this.state = STATE.IN_SYNC;
            this.peakSync = syncPow;
            if (this.onSignal) this.onSignal({ kind: "sync-rising", energy: syncPow });
          }
          this.searchClock += this.searchHopSamples;
        } else if (this.state === STATE.IN_SYNC) {
          if (syncPow > this.peakSync) this.peakSync = syncPow;
          if (syncPow < this.peakSync * 0.15 || syncPow < this.noiseFloor * 8) {
            const syncEndApprox = wEnd - this.syncWindowSamples;
            this.symbolClock = syncEndApprox + this.syncGapSamples;
            this.state = STATE.LOCKED;
            this.frameBytes = [];
            this.frameTargetBytes = 0;
            this.searchClock = this.symbolClock;
            if (this.onSignal) this.onSignal({ kind: "sync-locked" });
          } else {
            this.searchClock += this.searchHopSamples;
          }
        }
      } else if (this.state === STATE.LOCKED) {
        const symStart = this.symbolClock;
        const symEnd = symStart + this.symbolSamples;
        if (this.totalSamplesProcessed < symEnd) return;
        const margin = Math.floor(this.symbolSamples * 0.15);
        const innerLen = this.symbolSamples - 2 * margin;
        const buf = this._readWindow(symEnd - margin, innerLen);
        if (!buf) {
          this._abort("buffer-lost");
          continue;
        }
        const { byte, power } = this._readByte(buf, 0, buf.length);
        if (power <= 0) {
          this._abort("no-energy");
          continue;
        }
        this.frameBytes.push(byte);
        this.symbolClock = symEnd;

        // 7 header bytes (1 symbol each) → check magic + read length.
        if (this.frameTargetBytes === 0 && this.frameBytes.length >= 7) {
          if (this.frameBytes[0] !== MAGIC) {
            this._abort("bad-magic");
            continue;
          }
          const len = this.frameBytes[6];
          this.frameTargetBytes = 9 + len;
          if (this.frameTargetBytes > 9 + 255) {
            this._abort("len-too-big");
            continue;
          }
        }

        if (this.frameTargetBytes > 0 && this.frameBytes.length >= this.frameTargetBytes) {
          const bytes = Uint8Array.from(this.frameBytes.slice(0, this.frameTargetBytes));
          const parsed = parseFrame(bytes);
          if (parsed) {
            const accepted = this.assembler.add(parsed);
            if (accepted && this.onFrame) {
              this.onFrame({
                seq: parsed.seq,
                total: parsed.total,
                have: this.assembler.haveCount(),
                missing: this.assembler.missing(),
                complete: this.assembler.isComplete(),
              });
            }
            if (this.assembler.isComplete()) {
              const full = this.assembler.assemble();
              if (this.onSignal) this.onSignal({ kind: "complete", payload: full });
            }
          } else if (this.onSignal) {
            this.onSignal({ kind: "bad-frame" });
          }
          this.state = STATE.SEARCH;
          this.frameBytes = [];
          this.frameTargetBytes = 0;
          this.peakSync = 0;
          this.searchClock = this.symbolClock;
        }
      }
    }
  }

  _abort(reason) {
    if (this.onSignal) this.onSignal({ kind: "abort", reason });
    this.state = STATE.SEARCH;
    this.frameBytes = [];
    this.frameTargetBytes = 0;
    this.peakSync = 0;
    this.searchClock = this.symbolClock;
  }
}
