# PROJECT.md — ThinAir

## 1. Project Summary

**ThinAir** is a static, browser-only file transfer app for phones and computers. It uses **WebRTC DataChannels** for direct peer-to-peer file transfer and uses physical/local signaling methods instead of a backend.

The app is designed to be hosted as a static site on GitHub Pages, Cloudflare Pages, Netlify static hosting, or any plain HTTP server.

Core idea:

```text
The file moves over WebRTC.
The handshake moves through QR codes, text, and audio chirps.
No storage backend.
No uploaded files on a server.
No account.
No paid service.
```

ThinAir has three primary transfer paths:

1. **Phone ↔ Phone** using QR-code signaling.
2. **Phone ↔ Computer / Computer ↔ Phone** using QR code in one direction and microphone/audio chirp in the other direction.
3. **Audio-only acoustic pairing** where nearby devices exchange the WebRTC handshake through chirps, then transfer the file over WebRTC.

The project prioritizes:

- zero-cost operation
- static hosting
- no file storage
- local-first physical pairing
- memorable UX
- clear fallback paths
- no required webcam on desktop

See full spec in this repo. Core principle: the file moves over WebRTC; the handshake moves through QR codes, text, and audio chirps.
