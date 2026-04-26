// Envelopes for offer/answer over QR / audio / paste.
import { encodeEnvelope, decodeEnvelope, newSessionId } from "../codec/compress.js";

export function makeOfferEnvelope(sdp, sessionId) {
  return {
    v: 1,
    app: "thinair",
    type: "offer",
    id: sessionId,
    sdp,
    ts: Date.now(),
  };
}

export function makeAnswerEnvelope(sdp, sessionId) {
  return {
    v: 1,
    app: "thinair",
    type: "answer",
    id: sessionId,
    sdp,
    ts: Date.now(),
  };
}

export function envelopeToString(env) {
  return encodeEnvelope(env);
}

export function envelopeToUrl(env, base = location.href.split("#")[0]) {
  return base + "#thinair=" + encodeEnvelope(env);
}

export function parsePayload(text) {
  if (!text) throw new Error("empty payload");
  let s = text.trim();
  if (s.startsWith("thinair:")) s = s.slice(8);
  if (s.includes("#thinair=")) s = s.split("#thinair=")[1];
  if (s.includes("?thinair=")) s = s.split("?thinair=")[1];
  // Tolerate full URL with hash
  return decodeEnvelope(s);
}

export { newSessionId };
