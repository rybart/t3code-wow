// Strip encryption, the bridge's end of addon/Orca/Core/Crypto.lua.
//
// The strip is on screen, so anyone watching a stream or recording could decode it.
// Frames therefore carry
//
//   nonce (12) | ChaCha20 ciphertext | HMAC-SHA-256 tag, first 8 bytes
//
// with the tag over version, seq, nonce and ciphertext. The keys reach the addon only
// through the slot files (written to disk, never shown). Without the keys a frame is
// noise, and a forged or altered one fails the tag. Replays don't help either: the
// bridge only runs command ids it hasn't run before.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const NONCE_BYTES = 12;
export const TAG_BYTES = 8;
export const OVERHEAD = NONCE_BYTES + TAG_BYTES;
export const ENCRYPTED_VERSION = 2;

// A random master key per install, kept in the state directory (0600).
export function loadOrCreateKey(stateDir) {
  const file = path.join(stateDir, 'strip.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function deriveKeys(master) {
  const hmac = (label) => crypto.createHmac('sha256', master).update(label).digest();
  const enc = hmac('orca-wow strip encryption');
  const mac = hmac('orca-wow strip authentication');
  // What the addon gets in every snapshot.
  return { enc, mac, hex: enc.toString('hex') + mac.toString('hex') };
}

function chacha(key, nonce, data) {
  const iv = Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]); // block counter 1, as in RFC 8439
  const c = crypto.createCipheriv('chacha20', key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

function tagFor(keys, version, seq, nonce, ciphertext) {
  return crypto
    .createHmac('sha256', keys.mac)
    .update(Buffer.from([version, (seq >> 8) & 0xff, seq & 0xff]))
    .update(nonce)
    .update(ciphertext)
    .digest()
    .subarray(0, TAG_BYTES);
}

// For tests and tools: what the addon does.
export function seal(keys, seq, nonce, plaintext) {
  const ct = chacha(keys.enc, nonce, Buffer.from(plaintext));
  return Buffer.concat([nonce, ct, tagFor(keys, ENCRYPTED_VERSION, seq, nonce, ct)]);
}

// Returns the plaintext, or null if the frame isn't authentic.
export function open(keys, seq, payload) {
  if (payload.length < OVERHEAD) return null;
  const nonce = payload.subarray(0, NONCE_BYTES);
  const ct = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  if (!crypto.timingSafeEqual(tag, tagFor(keys, ENCRYPTED_VERSION, seq, nonce, ct))) return null;
  return chacha(keys.enc, nonce, ct);
}
