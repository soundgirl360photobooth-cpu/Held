// Server-side crypto helpers.
//
// IMPORTANT: this module deliberately does NOT contain a function that turns
// a user-chosen passcode into a verifier on the server. That derivation only
// ever happens in the browser (see public/index.html), using the identical
// PBKDF2 scheme, so the server never receives a user's real passcode in any
// form. The one exception is deriveFromPasscode() below, which the server
// legitimately calls on temporary passcodes *it generates itself* (for admin
// resets and self-service "forgot passcode" resets) — those are the server's
// own freshly-random secrets, disclosed once via email and then discarded.
const { webcrypto } = require('crypto');
const subtle = webcrypto.subtle;

function bufToHex(buf) {
  return Buffer.from(buf).toString('hex');
}
function hexToBuf(hex) {
  return Buffer.from(hex, 'hex');
}
function randomHex(len) {
  return bufToHex(webcrypto.getRandomValues(new Uint8Array(len)));
}

// Same PBKDF2 scheme as the client: 150k iterations, SHA-256, 512 bits out,
// first 32 bytes = login verifier, last 32 bytes = AES-GCM key material.
// The server only ever keeps the verifier half.
async function deriveFromPasscode(passcode, saltHex) {
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    'raw',
    enc.encode(passcode),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuf(saltHex), iterations: 150000, hash: 'SHA-256' },
    baseKey,
    512
  );
  const bytes = Buffer.from(bits);
  return { verifier: bytes.slice(0, 32).toString('hex') };
}

function randomPasscode(len = 12) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = webcrypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return '(no email on file)';
  const [name, domain] = email.split('@');
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}

module.exports = { randomHex, randomPasscode, deriveFromPasscode, maskEmail };
