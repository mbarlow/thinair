// Multi-band FSK decoder with chirp-sweep matched-filter sync.
//
// Sync: a streaming I/Q correlation against the encoder's linear-FM sweep
// template. Peak of |corr| gives sample-accurate end-of-sweep alignment;
// symbols start at peak + sweepGapSamples on a stable grid.
//
// Data: each symbol slot carries one byte split across 4 sub-bands × 4-FSK.

import { getProfile } from "./profiles.js";
import { parseFrame, FrameAssembler, MAGIC } from "./framing.js";
import { makeSweepTemplates } from "./chirp-encode.js";

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
  PEAK_RISING: "peak-rising",
  LOCKED: "locked",
};

// Decimation factor for streaming correlation: step both input and template
// by this many samples. Saves CPU; precision = D samples ≈ 167 µs at 48 kHz,
// negligible vs a 60 ms symbol.
const CORR_DECIMATE = 8;
// Minimum correlation magnitude to consider a candidate sync peak. Calibrated
// against the I/Q template normalization: a perfectly aligned 0.55-amplitude
// sweep produces a peak around 2.8; data-symbol cross-correlation tops out
// near 0.2; quiet-room noise hovers below 0.05. 0.5 puts a clean separator
// between "real sweep" and "anything else."
const MIN_PEAK = 0.5;

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
    this.sweepSamples = 0;
    this.sweepGapSamples = 0;
    this.bandKs = null;
    this.searchClock = 0;
    this.searchHopSamples = CORR_DECIMATE;
    // Matched filter
    this.tmplI = null;
    this.tmplQ = null;
    this.tmplDecLen = 0; // length of decimated template
    this.corrNoiseEwma = 1e-9;
    this.corrPrev = 0;
    this.peakCorr = 0;
    this.peakAt = 0;
    this.peakDecayCount = 0;
    // Frame state
    this.state = STATE.SEARCH;
    this.frameBytes = [];
    this.frameTargetBytes = 0;
    this.symbolClock = 0;
    this.assembler = new FrameAssembler();
    this.lastLevel = 0;
    this.lastCorr = 0;
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
    this.sweepSamples = Math.floor(p.sweepMs / 1000 * sr);
    this.sweepGapSamples = Math.floor(p.sweepGapMs / 1000 * sr);
    this.bandKs = p.bands.map((band) => band.map((f) => f / sr));

    // Pre-compute decimated I/Q templates.
    const fullTpl = makeSweepTemplates(this.sweepSamples, p.sweepStartHz, p.sweepEndHz, sr);
    const decLen = Math.floor(this.sweepSamples / CORR_DECIMATE);
    const ti = new Float32Array(decLen);
    const tq = new Float32Array(decLen);
    for (let i = 0; i < decLen; i++) {
      ti[i] = fullTpl.i[i * CORR_DECIMATE];
      tq[i] = fullTpl.q[i * CORR_DECIMATE];
    }
    this.tmplI = ti;
    this.tmplQ = tq;
    this.tmplDecLen = decLen;

    const maxFrameBytes = (9 + 255);
    const maxFrameSamples = maxFrameBytes * this.symbolSamples;
    const ringSize = Math.max(sr * 2, this.sweepSamples + maxFrameSamples + this.sweepGapSamples + sr);
    this.buf = new Float32Array(ringSize);
    this.bufWritePos = 0;
    this.bufFilled = 0;
    this.totalSamplesProcessed = 0;
    this.searchClock = this.sweepSamples; // need at least sweepSamples buffered
    this.symbolClock = 0;
    this.state = STATE.SEARCH;
    this.frameBytes = [];
    this.frameTargetBytes = 0;
    this.peakCorr = 0;
    this.peakAt = 0;
    this.peakDecayCount = 0;
    this.corrNoiseEwma = 1e-9;
    this.corrPrev = 0;
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
    this.peakCorr = 0;
    this.peakDecayCount = 0;
    this.corrPrev = 0;
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

  // Magnitude of the I/Q matched-filter correlation between the sweep template
  // and the input window ending at endAbs.
  _correlateSweep(endAbs) {
    const w = this._readWindow(endAbs, this.sweepSamples);
    if (!w) return 0;
    let r = 0, im = 0;
    for (let i = 0; i < this.tmplDecLen; i++) {
      const x = w[i * CORR_DECIMATE];
      r += x * this.tmplI[i];
      im += x * this.tmplQ[i];
    }
    return Math.sqrt(r * r + im * im);
  }

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
      if (this.state === STATE.SEARCH || this.state === STATE.PEAK_RISING) {
        if (this.totalSamplesProcessed < this.searchClock) return;
        const corr = this._correlateSweep(this.searchClock);
        this.lastCorr = corr;

        if (this.state === STATE.SEARCH) {
          // Update background noise estimate when the value looks like noise
          // (i.e. well below the floor). Avoids polluting it with sweep peaks.
          if (corr < MIN_PEAK) {
            this.corrNoiseEwma = this.corrNoiseEwma * 0.98 + corr * 0.02;
          }
          const thresh = Math.max(this.corrNoiseEwma * 8, MIN_PEAK);
          if (corr > thresh && corr > this.corrPrev) {
            this.peakCorr = corr;
            this.peakAt = this.searchClock;
            this.peakDecayCount = 0;
            this.state = STATE.PEAK_RISING;
            if (this.onSignal) this.onSignal({ kind: "sync-rising", energy: corr });
          }
          this.corrPrev = corr;
          this.searchClock += this.searchHopSamples;
        } else { // PEAK_RISING
          if (corr > this.peakCorr) {
            this.peakCorr = corr;
            this.peakAt = this.searchClock;
            this.peakDecayCount = 0;
          } else {
            this.peakDecayCount++;
            // After several decreasing samples we're confident the peak passed.
            if (this.peakDecayCount > 6) {
              this.symbolClock = this.peakAt + this.sweepGapSamples;
              this.state = STATE.LOCKED;
              this.frameBytes = [];
              this.frameTargetBytes = 0;
              this.searchClock = this.symbolClock;
              this.corrPrev = 0;
              if (this.onSignal) this.onSignal({ kind: "sync-locked", peak: this.peakCorr });
              continue;
            }
          }
          this.searchClock += this.searchHopSamples;
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
          this.peakCorr = 0;
          this.peakDecayCount = 0;
          this.corrPrev = 0;
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
    this.peakCorr = 0;
    this.peakDecayCount = 0;
    this.corrPrev = 0;
    this.searchClock = this.symbolClock;
  }
}
