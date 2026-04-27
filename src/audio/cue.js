// Tiny audio cue: a short tone burst used as a UX-only "step done" signal
// between devices. No data — the receiver just needs to know "the other
// device finished its step, switch UI now."
//
// Burst design: a triple-tap of 2 kHz tones (220 ms each, 90 ms gap), so the
// pattern is rhythmically distinguishable from incidental room noise even at
// modest volume. Detection uses a Goertzel filter at the same frequency and
// counts three energy peaks within a 1.5 s window.

const CUE_HZ = 2000;
const PULSE_MS = 220;
const GAP_MS = 90;
const PULSES = 3;
const DETECT_WINDOW_MS = 30;
const PEAK_THRESHOLD = 1.6e-3; // tuned for unit-amplitude FFT-style scaling

export function buildCueBuffer(audioCtx) {
  const sr = audioCtx.sampleRate;
  const pulseSamples = Math.floor(PULSE_MS / 1000 * sr);
  const gapSamples = Math.floor(GAP_MS / 1000 * sr);
  const total = pulseSamples * PULSES + gapSamples * (PULSES - 1) + Math.floor(0.05 * sr);
  const buffer = audioCtx.createBuffer(1, total, sr);
  const out = buffer.getChannelData(0);
  const omega = 2 * Math.PI * CUE_HZ / sr;
  let off = 0;
  for (let p = 0; p < PULSES; p++) {
    const fade = Math.min(pulseSamples / 4, Math.floor(0.012 * sr));
    for (let i = 0; i < pulseSamples; i++) {
      let env = 1;
      if (i < fade) env = 0.5 * (1 - Math.cos(Math.PI * i / fade));
      else if (i > pulseSamples - fade) env = 0.5 * (1 - Math.cos(Math.PI * (pulseSamples - i) / fade));
      out[off + i] = 0.5 * env * Math.sin(omega * i);
    }
    off += pulseSamples + gapSamples;
  }
  return buffer;
}

export async function playCue(audioCtx) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const buf = buildCueBuffer(audioCtx);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const g = audioCtx.createGain();
  g.gain.value = 0.9;
  src.connect(g);
  g.connect(audioCtx.destination);
  src.start();
  return new Promise((res) => { src.onended = () => res(); });
}

function goertzel(samples, len, k) {
  const omega = 2 * Math.PI * k;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / len;
}

// Listen for the cue. Calls onCue() once when the 3-pulse pattern is heard.
// Returns a stop() function. Yields false from start() if the user denies mic.
export class CueListener {
  constructor() {
    this.audioCtx = null;
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.running = false;
    this.peakTimes = [];
    this.aboveThreshold = false;
    this.onCue = null;
  }

  async start(onCue) {
    if (this.running) return true;
    this.onCue = onCue;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch {
      return false;
    }
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
    const sr = this.audioCtx.sampleRate;
    const winSamples = Math.max(256, Math.floor(DETECT_WINDOW_MS / 1000 * sr));
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    let buffered = new Float32Array(0);
    const k = CUE_HZ / sr;
    this.processor.onaudioprocess = (ev) => {
      const inp = ev.inputBuffer.getChannelData(0);
      ev.outputBuffer.getChannelData(0).fill(0);
      // simple sliding window
      const cat = new Float32Array(buffered.length + inp.length);
      cat.set(buffered, 0);
      cat.set(inp, buffered.length);
      let i = 0;
      while (i + winSamples <= cat.length) {
        const win = cat.subarray(i, i + winSamples);
        const p = goertzel(win, win.length, k);
        const above = p > PEAK_THRESHOLD;
        if (above && !this.aboveThreshold) {
          this.peakTimes.push(this.audioCtx.currentTime);
          // drop peaks older than DETECT_WINDOW
          const cutoff = this.audioCtx.currentTime - 1.5;
          while (this.peakTimes.length && this.peakTimes[0] < cutoff) this.peakTimes.shift();
          if (this.peakTimes.length >= PULSES && !this._fired) {
            this._fired = true;
            this.onCue && this.onCue();
          }
        }
        this.aboveThreshold = above;
        i += winSamples;
      }
      buffered = cat.subarray(i);
    };
    this.sink = this.audioCtx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.audioCtx.destination);
    this.running = true;
    return true;
  }

  stop() {
    this.running = false;
    try { this.processor && this.processor.disconnect(); } catch {}
    try { this.sink && this.sink.disconnect(); } catch {}
    try { this.source && this.source.disconnect(); } catch {}
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.audioCtx) try { this.audioCtx.close(); } catch {}
    this.audioCtx = this.stream = this.processor = this.sink = this.source = null;
  }
}
