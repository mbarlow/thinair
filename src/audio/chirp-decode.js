// FSK decoder. Listens via getUserMedia, tracks energy at the sync tone, locks
// the symbol grid on the falling edge of the preamble, then reads symbols
// using middle-of-symbol Goertzel windows.

import { getProfile } from "./profiles.js";
import { parseFrame, FrameAssembler, MAGIC } from "./framing.js";

// Goertzel power for a given normalized frequency k = freq/sampleRate.
function goertzel(samples, off, len, k) {
  const omega = 2 * Math.PI * k;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = samples[off + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / len; // power-per-sample, comparable across window sizes
}

// Snapshot Goertzel: window-relative offset and length, into a Float32Array.
function goertzelOn(buf, off, len, k) {
  return goertzel(buf, off, len, k);
}

const STATE = {
  SEARCH: "search",       // looking for sync energy to rise
  IN_SYNC: "in-sync",     // sync energy is high, waiting for it to fall
  LOCKED: "locked",       // sync ended; reading data symbols on the locked grid
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
    this.dataKs = [];
    this.syncK = 0;
    this.syncGapSamples = 0;
    this.bandLowK = 0;
    this.bandHighK = 0;
    this.state = STATE.SEARCH;
    this.frameSymbols = [];
    this.frameTargetSymbols = 0;
    this.symbolClock = 0;          // next symbol start (absolute sample)
    this.searchClock = 0;          // sliding search position (absolute sample)
    this.searchHopSamples = 0;
    this.assembler = new FrameAssembler();
    this.noiseFloor = 1e-9;        // EWMA of "non-signal" sync energy
    this.peakSync = 0;             // running peak of sync energy in current SYNC episode
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

    const p = this.profile;
    this.symbolSamples = Math.floor(p.symbolMs / 1000 * this.sampleRate);
    this.syncWindowSamples = Math.max(256, Math.floor(0.030 * this.sampleRate)); // 30 ms detection window
    this.searchHopSamples = Math.max(64, Math.floor(this.syncWindowSamples / 4));
    this.syncGapSamples = Math.floor(p.syncGapMs / 1000 * this.sampleRate);
    this.dataKs = p.tones.map((f) => f / this.sampleRate);
    this.syncK = p.syncHz / this.sampleRate;
    this.bandLowK = (p.minHz / this.sampleRate);
    this.bandHighK = (p.maxHz / this.sampleRate);

    // Ring buffer holds at least the longest frame plus one sync episode of history.
    const maxFrameSyms = 2 * (9 + 255);
    const maxFrameSamples = maxFrameSyms * this.symbolSamples;
    const minSyncSamples = Math.floor(p.syncMs / 1000 * this.sampleRate) + this.syncGapSamples;
    const ringSize = Math.max(this.sampleRate * 2, maxFrameSamples + minSyncSamples + this.sampleRate);
    this.buf = new Float32Array(ringSize);
    this.bufWritePos = 0;
    this.bufFilled = 0;
    this.totalSamplesProcessed = 0;
    this.searchClock = 0;
    this.symbolClock = 0;
    this.state = STATE.SEARCH;
    this.frameSymbols = [];
    this.frameTargetSymbols = 0;
    this.peakSync = 0;
    this.noiseFloor = 1e-9;

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
      const o = ev.outputBuffer.getChannelData(0);
      o.fill(0);
    };
    this._sink = this.audioCtx.createGain();
    this._sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this._sink);
    this._sink.connect(this.audioCtx.destination);
    this.running = true;
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
    this.frameSymbols = [];
    this.frameTargetSymbols = 0;
    this.peakSync = 0;
  }

  _onSamples(input) {
    const len = input.length;
    let amp = 0;
    for (let i = 0; i < len; i++) amp += Math.abs(input[i]);
    this.lastLevel = amp / len;
    if (this.onLevel) this.onLevel(this.lastLevel);

    // append to ring
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

  // Get a contiguous Float32 view of `count` samples ending at absolute sample `endAbs`.
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

  _bestDataNibble(buf, off, len) {
    let best = -1, bestPow = 0;
    for (let i = 0; i < this.dataKs.length; i++) {
      const p = goertzelOn(buf, off, len, this.dataKs[i]);
      if (p > bestPow) { bestPow = p; best = i; }
    }
    return { nibble: best, power: bestPow };
  }

  _process() {
    while (true) {
      if (this.state === STATE.SEARCH || this.state === STATE.IN_SYNC) {
        // Slide a sync-detection window every searchHopSamples.
        const wEnd = this.searchClock + this.syncWindowSamples;
        if (this.totalSamplesProcessed < wEnd) return;
        const w = this._readWindow(wEnd, this.syncWindowSamples);
        if (!w) { this.searchClock += this.searchHopSamples; continue; }
        const syncPow = goertzelOn(w, 0, w.length, this.syncK);
        // Compare against in-band data energy as a "is anything else loud?" baseline.
        const dataPow = goertzelOn(w, 0, w.length, (this.bandLowK + this.bandHighK) / 2);

        if (this.state === STATE.SEARCH) {
          // EWMA noise floor on quiet frames
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
          // Falling edge: energy drops to a small fraction of peak.
          if (syncPow < this.peakSync * 0.15 || syncPow < this.noiseFloor * 8) {
            // The fall happened somewhere inside this window. Approximate: the
            // sync ended at the *start* of this window, then a syncGapSamples
            // silence, then symbols start.
            const syncEndApprox = wEnd - this.syncWindowSamples;
            this.symbolClock = syncEndApprox + this.syncGapSamples;
            this.state = STATE.LOCKED;
            this.frameSymbols = [];
            this.frameTargetSymbols = 0;
            this.searchClock = this.symbolClock; // searchClock advances with symbols now
            if (this.onSignal) this.onSignal({ kind: "sync-locked" });
          } else {
            this.searchClock += this.searchHopSamples;
          }
        }
      } else if (this.state === STATE.LOCKED) {
        // Read one symbol at symbolClock. Sample only the middle 70% to avoid
        // attack/decay envelopes and any residual sync-tail bleed.
        const symStart = this.symbolClock;
        const symEnd = symStart + this.symbolSamples;
        if (this.totalSamplesProcessed < symEnd) return;
        const margin = Math.floor(this.symbolSamples * 0.15);
        const innerLen = this.symbolSamples - 2 * margin;
        const buf = this._readWindow(symEnd - margin, innerLen);
        if (!buf) {
          // Lost the buffer somehow — abort
          this._abort("buffer-lost");
          continue;
        }
        const { nibble, power } = this._bestDataNibble(buf, 0, buf.length);
        if (nibble < 0 || power <= 0) {
          this._abort("no-energy");
          continue;
        }
        this.frameSymbols.push(nibble);
        this.symbolClock = symEnd;

        // After 14 symbols we have a 7-byte header; check magic + read len.
        if (this.frameTargetSymbols === 0 && this.frameSymbols.length >= 14) {
          const headerBytes = nibblesToBytes(this.frameSymbols.slice(0, 14));
          if (headerBytes[0] !== MAGIC) {
            this._abort("bad-magic");
            continue;
          }
          const len = headerBytes[6];
          this.frameTargetSymbols = 2 * (9 + len);
          if (this.frameTargetSymbols > 2 * (9 + 255)) {
            this._abort("len-too-big");
            continue;
          }
        }

        if (this.frameTargetSymbols > 0 && this.frameSymbols.length >= this.frameTargetSymbols) {
          const bytes = nibblesToBytes(this.frameSymbols.slice(0, this.frameTargetSymbols));
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
          this.frameSymbols = [];
          this.frameTargetSymbols = 0;
          this.peakSync = 0;
          this.searchClock = this.symbolClock;
        }
      }
    }
  }

  _abort(reason) {
    if (this.onSignal) this.onSignal({ kind: "abort", reason });
    this.state = STATE.SEARCH;
    this.frameSymbols = [];
    this.frameTargetSymbols = 0;
    this.peakSync = 0;
    this.searchClock = this.symbolClock;
  }
}

function nibblesToBytes(nibbles) {
  const out = new Uint8Array(Math.floor(nibbles.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = ((nibbles[i * 2] & 0xf) << 4) | (nibbles[i * 2 + 1] & 0xf);
  }
  return out;
}
