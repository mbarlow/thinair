// Envelopes for offer/answer.
// v2: native binary envelope via sdp-pack (compact). Text/QR encodes the bytes
// as base64url. Audio sends raw bytes. v1 JSON-base64 envelopes are still
// accepted on the receive side for back-compat.

import { packSDP, unpackSDP, isPackedEnvelope } from "./sdp-pack.js";
import { bytesToBase64Url, base64UrlToBytes, bytesToStr } from "../codec/base.js";
import { decodeEnvelope, newSessionId } from "../codec/compress.js";

export function makeOfferBytes(sdp, sessionId) {
  return packSDP(sdp, "offer", sessionId || "");
}

export function makeAnswerBytes(sdp, sessionId) {
  return packSDP(sdp, "answer", sessionId || "");
}

export function bytesToText(bytes) {
  return bytesToBase64Url(bytes);
}

function stripTextPrefixes(text) {
  let s = (text || "").trim();
  if (s.startsWith("thinair:")) s = s.slice(8);
  if (s.includes("#thinair=")) s = s.split("#thinair=")[1];
  if (s.includes("?thinair=")) s = s.split("?thinair=")[1];
  return s;
}

// Parse a payload coming from QR / pasted text. Tries the new binary
// envelope first (base64url-encoded bytes), falls back to legacy JSON.
export function parsePayloadFromText(text) {
  const body = stripTextPrefixes(text);
  if (!body) throw new Error("empty payload");
  let bytes = null;
  try { bytes = base64UrlToBytes(body); } catch {}
  if (bytes && isPackedEnvelope(bytes)) {
    return unpackSDP(bytes);
  }
  // Legacy JSON envelope (deflated, base64url'd).
  try {
    const env = decodeEnvelope(body);
    return { type: env.type, sdp: env.sdp, id: env.id };
  } catch (e) {
    throw new Error("could not parse payload: " + e.message);
  }
}

// Parse a payload coming from the audio chirp. Native bytes preferred; if we
// get UTF-8 base64 text bytes (legacy v1 sender), decode that path too.
export function parsePayloadFromBytes(bytes) {
  if (!bytes || bytes.length === 0) throw new Error("empty payload");
  if (isPackedEnvelope(bytes)) return unpackSDP(bytes);
  const text = bytesToStr(bytes);
  return parsePayloadFromText(text);
}

export { newSessionId };
