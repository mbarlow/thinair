// Step-done audio cue. UX-only signal that says "your turn"; carries no data.
//
// Sound: a soft two-note chime — E5 (659 Hz) up to B5 (988 Hz). Long enough
// for a Goertzel detector to lock fast, short enough not to be annoying,
// pitched in a clean register so phone speakers reproduce it cleanly and the
// detection band sits well above HVAC/voice clutter.
//
// Detector: Goertzel at the *upper* tone (988 Hz, less likely to coincide
// with random room noise). One sustained ~120 ms detection above threshold
// fires the callback. Latency from cue start to "your turn" is typically
// 200–250 ms — fast enough that the sender's UI feels responsive.

const TONE1_HZ = 659.25; // E5
const TONE2_HZ = 987.77; // B5
const TONE1_MS = 180;
const GAP_MS = 30;
const TONE2_MS = 220;

const DETECT_HZ = TONE2_HZ;
const DETECT_WINDOW_MS = 30;
const SUSTAIN_MS = 120; // need this many ms of continuous above-threshold
const PEAK_THRESHOLD = 1.5e-3;

function softTone(out, off, count, freq, sr, amp) {
  const omega = 2 * Math.PI * freq / sr;
  const fade = Math.min(count / 4, Math.floor(0.018 * sr)); // 18 ms attack/release
  for (let i = 0; i < count; i++) {
    let env = 1;
    if (i < fade) env = 0.5 * (1 - Math.cos(Math.PI * i / fade));
    else if (i > count - fade) env = 0.5 * (1 - Math.cos(Math.PI * (count - i) / fade));
    out[off + i] = amp * env * Math.sin(omega * i);
  }
}

export function buildCueBuffer(audioCtx) {
  const sr = audioCtx.sampleRate;
  const n1 = Math.floor(TONE1_MS / 1000 * sr);
  const ng = Math.floor(GAP_MS / 1000 * sr);
  const n2 = Math.floor(TONE2_MS / 1000 * sr);
  const tail = Math.floor(0.06 * sr);
  const total = n1 + ng + n2 + tail;
  const buffer = audioCtx.createBuffer(1, total, sr);
  const out = buffer.getChannelData(0);
  softTone(out, 0, n1, TONE1_HZ, sr, 0.4);
  softTone(out, n1 + ng, n2, TONE2_HZ, sr, 0.42);
  return buffer;
}

export async function playCue(audioCtx) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const buf = buildCueBuffer(audioCtx);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const g = audioCtx.createGain();
  g.gain.value = 0.95;
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

// Listen for the cue. Calls onCue() the first time the detection tone is
// sustained above threshold for SUSTAIN_MS. Returns false if mic is denied.
export class CueListener {
  constructor() {
    this.audioCtx = null;
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.running = false;
    this.aboveSinceTime = 0;
    this._fired = false;
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
    const sustainSec = SUSTAIN_MS / 1000;
    const detectK = DETECT_HZ / sr;

    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    let buffered = new Float32Array(0);

    this.processor.onaudioprocess = (ev) => {
      const inp = ev.inputBuffer.getChannelData(0);
      ev.outputBuffer.getChannelData(0).fill(0);
      const cat = new Float32Array(buffered.length + inp.length);
      cat.set(buffered, 0);
      cat.set(inp, buffered.length);
      let i = 0;
      while (i + winSamples <= cat.length) {
        const win = cat.subarray(i, i + winSamples);
        const p = goertzel(win, win.length, detectK);
        const t = this.audioCtx.currentTime;
        if (p > PEAK_THRESHOLD) {
          if (this.aboveSinceTime === 0) this.aboveSinceTime = t;
          if (!this._fired && t - this.aboveSinceTime >= sustainSec) {
            this._fired = true;
            this.onCue && this.onCue();
          }
        } else {
          this.aboveSinceTime = 0;
        }
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
