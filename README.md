# ThinAir

Static, browser-only file transfer. WebRTC for the file. QR codes, text, and audio chirps for the handshake.

```
The file moves over WebRTC.
The handshake moves through QR codes, text, and audio chirps.
No storage backend.
No uploaded files on a server.
No account.
No paid service.
```

## Live

GitHub Pages: <https://mbarlow.github.io/thinair/>

Open the page on two devices, pick a file on one, pair the devices, transfer.

## Modes

- **Send / Receive** — pick file (sender), pair via QR code, audio chirp, or pasted text, then transfer.
- **Manual Pair** — copy/paste only. No camera or microphone needed.
- **Diagnostics** — check WebRTC, microphone, camera, and STUN reachability.

## Constraints (v1)

- Both devices must be online during the transfer (no relay, no storage).
- Audio chirp signaling carries small payloads only — full WebRTC offers usually need QR or text.
- No TURN server. Some restrictive networks will fail.
- Google STUN is the only external network helper.

## Layout

```
index.html
styles.css
src/
  app.js, router.js
  webrtc/   peer.js, file-transfer.js, signaling.js
  qr/       qr-generate.js, qr-scan.js
  audio/    profiles.js, framing.js, chirp-encode.js, chirp-decode.js
  codec/    base.js, checksum.js, compress.js
  ui/       home-view.js, send-view.js, receive-view.js, manual-view.js,
            diagnostics-view.js, signaling-widgets.js, util.js
```

No build step. Vanilla ES modules. CDN-loaded `qrcode`, `jsQR`, and `pako`.

## Spec

See [PROJECT.md](./PROJECT.md).
