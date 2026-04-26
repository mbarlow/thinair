// Compression via pako (loaded as global from CDN).
import { strToBytes, bytesToStr, bytesToBase64Url, base64UrlToBytes } from "./base.js";

function getPako() {
  if (typeof window !== "undefined" && window.pako) return window.pako;
  throw new Error("pako not loaded");
}

export function deflateString(s) {
  return getPako().deflateRaw(strToBytes(s));
}

export function inflateString(bytes) {
  return bytesToStr(getPako().inflateRaw(bytes));
}

// Encode an envelope object into a compact base64url payload.
export function encodeEnvelope(obj) {
  const json = JSON.stringify(obj);
  const compressed = deflateString(json);
  return bytesToBase64Url(compressed);
}

export function decodeEnvelope(s) {
  const bytes = base64UrlToBytes(s);
  const json = inflateString(bytes);
  return JSON.parse(json);
}

// Random short session id, 6 chars uppercase
export function newSessionId() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const r = new Uint8Array(6);
  crypto.getRandomValues(r);
  for (let i = 0; i < 6; i++) s += a[r[i] % a.length];
  return s;
}
