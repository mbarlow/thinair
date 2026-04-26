// FSK decoder. Listens via getUserMedia, slides a symbol window, runs Goertzel
// detectors at each tone frequency, finds preamble syncs, then reads frames.

import { getProfile } from "./profiles.js";
import { parseFrame, FrameAssembler, MAGIC } from "./framing.js";

// Goertzel power for a given target frequency over the provided samples.
function goertzel(samples, off, len, k) {
  const omega = 2 * Math.PI * k;
  const cos = Math.cos(omega);
  const coeff = 2 * cos;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    s0 = samples[off + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  // power
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

export class ChirpDecoder {
  constructor(profileName, opts = {}) {
    this.profile = getProfile(profileName);
    this.opts = opts;
    this.audioCtx = null;
    this.source = null;
    this.processor = null;
    this.stream = null;
    this.running = false;
    this.buf = null;            // ring buffer of recent samples
    this.bufWritePos = 0;
    this.bufFilled = 0;
    this.symbolSamples = 0;
    this.hopSamples = 0;
    this.sampleRate = 0;
    // Goertzel "k" coefficients per tone
    this.dataKs = [];
    this.preambleKs = [];
    // State
    this.state = "search";       // "search" | "frame"
    this.frameSymbols = [];      // array of nibbles being read
    this.frameTargetSymbols = 0;
    this.symbolClock = 0;        // sample counter for next symbol
    this.assembler = new FrameAssembler();
    this.preambleHistory = [];
    this.totalBytesProcessed = 0;
    this.onFrame = null;
    this.onSignal = null;
    this.onLevel = null;
    this.lastLevel = 0;
  }

  async start({ onFrame, onSignal, onLevel }) {
    if (this.running) return;
    this.onFrame = onFrame;
    this.onSignal = onSignal;
    this.onLevel = onLevel;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
    this.sampleRate = this.audioCtx.sampleRate;
    this.symbolSamples = Math.floor(this.profile.symbolMs / 1000 * this.sampleRate);
    this.hopSamples = Math.max(1, Math.floor(this.symbolSamples / 4));
    this.buf = new Float32Array(this.symbolSamples * 32);
    this.bufWritePos = 0;
    this.bufFilled = 0;
    this.dataKs = this.profile.tones.map((f) => f / this.sampleRate);
    this.preambleKs = this.profile.preambleTones.map((f) => f / this.sampleRate);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    // ScriptProcessorNode (deprecated but universal). 4096 samples ~= 85ms at 48k.
    // Must have ≥1 output channel; route through a muted gain so mic isn't echoed.
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      this._onSamples(ev.inputBuffer.getChannelData(0));
      const out = ev.outputBuffer.getChannelData(0);
      out.fill(0);
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
    this.state = "search";
    this.frameSymbols = [];
    this.preambleHistory = [];
  }

  _onSamples(input) {
    // append to ring buffer
    const len = input.length;
    let lvl = 0;
    for (let i = 0; i < len; i++) lvl += Math.abs(input[i]);
    this.lastLevel = lvl / len;
    if (this.onLevel) this.onLevel(this.lastLevel);

    if (this.bufWritePos + len <= this.buf.length) {
      this.buf.set(input, this.bufWritePos);
      this.bufWritePos = (this.bufWritePos + len) % this.buf.length;
    } else {
      const first = this.buf.length - this.bufWritePos;
      this.buf.set(input.subarray(0, first), this.bufWritePos);
      this.buf.set(input.subarray(first), 0);
      this.bufWritePos = (this.bufWritePos + len) % this.buf.length;
    }
    this.bufFilled = Math.min(this.bufFilled + len, this.buf.length);
    this.totalBytesProcessed += len;

    this._process();
  }

  // Get a contiguous Float32Array view of the last `count` samples ending at `endAbs` (absolute sample count)
  // Returns null if not enough buffered.
  _readWindow(endAbs, count) {
    if (this.totalBytesProcessed < endAbs) return null;
    if (endAbs - count < this.totalBytesProcessed - this.bufFilled) return null;
    const ringEnd = this.bufWritePos - (this.totalBytesProcessed - endAbs);
    const startInRing = ((ringEnd - count) % this.buf.length + this.buf.length) % this.buf.length;
    if (startInRing + count <= this.buf.length) {
      return this.buf.subarray(startInRing, startInRing + count);
    } else {
      const out = new Float32Array(count);
      const first = this.buf.length - startInRing;
      out.set(this.buf.subarray(startInRing, this.buf.length), 0);
      out.set(this.buf.subarray(0, count - first), first);
      return out;
    }
  }

  _bestDataNibble(window) {
    let best = -1;
    let bestPow = 0;
    for (let i = 0; i < this.dataKs.length; i++) {
      const p = goertzel(window, 0, window.length, this.dataKs[i]);
      if (p > bestPow) {
        bestPow = p;
        best = i;
      }
    }
    return { nibble: best, power: bestPow };
  }

  _isPreambleWindow(window) {
    // Strongest tone among (data ∪ preamble) should be a preamble tone with clear margin.
    let preamblePow = 0;
    let preambleIdx = -1;
    for (let i = 0; i < this.preambleKs.length; i++) {
      const p = goertzel(window, 0, window.length, this.preambleKs[i]);
      if (p > preamblePow) { preamblePow = p; preambleIdx = i; }
    }
    let dataMaxPow = 0;
    for (let i = 0; i < this.dataKs.length; i++) {
      const p = goertzel(window, 0, window.length, this.dataKs[i]);
      if (p > dataMaxPow) dataMaxPow = p;
    }
    // de-dup distinct preamble tones (cycle)
    return preamblePow > dataMaxPow * 1.5 ? preambleIdx : -1;
  }

  _process() {
    // Try to consume in steps of `hopSamples` while we have at least symbolSamples buffered ahead of symbolClock.
    while (this.totalBytesProcessed - this.symbolClock >= this.symbolSamples) {
      const winEnd = this.symbolClock + this.symbolSamples;
      const window = this._readWindow(winEnd, this.symbolSamples);
      if (!window) {
        this.symbolClock = winEnd;
        continue;
      }
      if (this.state === "search") {
        const pIdx = this._isPreambleWindow(window);
        if (pIdx >= 0) {
          this.preambleHistory.push(pIdx);
          if (this.preambleHistory.length > this.profile.preambleTones.length) {
            this.preambleHistory.shift();
          }
          // If we've seen the full alternating preamble cycle, lock symbol clock
          if (this.preambleHistory.length === this.profile.preambleTones.length) {
            // Sliding step of one symbol — close enough; data starts after this window.
            if (this.onSignal) this.onSignal({ kind: "sync" });
            this.state = "frame";
            this.frameSymbols = [];
            this.frameTargetSymbols = 0; // will be set after header
            this.preambleHistory = [];
            this.symbolClock = winEnd;
            continue;
          }
          this.symbolClock = winEnd;
        } else {
          this.preambleHistory = [];
          this.symbolClock += this.hopSamples;
        }
      } else if (this.state === "frame") {
        const { nibble, power } = this._bestDataNibble(window);
        if (nibble < 0 || power <= 0) {
          // lost signal — bail
          this.state = "search";
          this.frameSymbols = [];
          this.symbolClock += this.hopSamples;
          continue;
        }
        this.frameSymbols.push(nibble);
        this.symbolClock = winEnd;
        // After 7 header bytes (14 symbols), determine total frame size
        if (this.frameTargetSymbols === 0 && this.frameSymbols.length >= 14) {
          const headerBytes = nibblesToBytes(this.frameSymbols.slice(0, 14));
          if (headerBytes[0] !== MAGIC) {
            // bad header — abort
            this.state = "search";
            this.frameSymbols = [];
            continue;
          }
          const len = headerBytes[6];
          // total frame bytes = 7 header + len + 2 crc = 9 + len; total symbols = 2 * (9 + len)
          this.frameTargetSymbols = 2 * (9 + len);
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
          this.state = "search";
          this.frameSymbols = [];
          this.frameTargetSymbols = 0;
        }
      }
    }
  }
}

function nibblesToBytes(nibbles) {
  const out = new Uint8Array(Math.floor(nibbles.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = ((nibbles[i * 2] & 0xf) << 4) | (nibbles[i * 2 + 1] & 0xf);
  }
  return out;
}
