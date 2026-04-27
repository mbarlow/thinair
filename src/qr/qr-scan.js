// QR scanning via getUserMedia + jsQR. Supports animated frames.
import { FRAG_PREFIX } from "./qr-generate.js";

export class QRScanner {
  constructor(videoEl, opts = {}) {
    this.video = videoEl;
    this.opts = opts;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.stream = null;
    this.running = false;
    this.fragments = new Map(); // id -> { total, parts: Map<seq, data> }
    this.lastDecoded = null;
  }

  async start(onResult, onStatus, opts = {}) {
    if (this.running) return;
    this.running = true;
    if (!window.jsQR) throw new Error("jsQR not loaded");
    if (opts.stream) {
      this.stream = opts.stream;
    } else {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        this.running = false;
        throw e;
      }
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "true");
    await this.video.play();

    const tick = () => {
      if (!this.running) return;
      if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
        const w = this.video.videoWidth;
        const h = this.video.videoHeight;
        if (w && h) {
          this.canvas.width = w;
          this.canvas.height = h;
          this.ctx.drawImage(this.video, 0, 0, w, h);
          const img = this.ctx.getImageData(0, 0, w, h);
          const code = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
          if (code && code.data) {
            const handled = this._handleData(code.data, onResult, onStatus);
            if (handled) {
              this.stop();
              return;
            }
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _handleData(data, onResult, onStatus) {
    if (data === this.lastDecoded) return false;
    this.lastDecoded = data;
    if (data.startsWith(FRAG_PREFIX)) {
      // thinair-frag:1:id:seq/total:chunk
      const rest = data.slice(FRAG_PREFIX.length);
      const m = rest.match(/^(\d+):([^:]+):(\d+)\/(\d+):(.*)$/s);
      if (!m) return false;
      const id = m[2];
      const seq = parseInt(m[3], 10);
      const total = parseInt(m[4], 10);
      const chunk = m[5];
      let entry = this.fragments.get(id);
      if (!entry) {
        entry = { total, parts: new Map() };
        this.fragments.set(id, entry);
      }
      entry.parts.set(seq, chunk);
      if (onStatus) onStatus({ kind: "fragment", id, have: entry.parts.size, total });
      if (entry.parts.size === total) {
        let assembled = "";
        for (let i = 1; i <= total; i++) {
          assembled += entry.parts.get(i) || "";
        }
        onResult(assembled);
        return true;
      }
      return false;
    }
    onResult(data);
    return true;
  }

  stop() {
    this.running = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}
