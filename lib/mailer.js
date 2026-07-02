// Real mailer, backed by Resend, with a simulated fallback.
//
// If RESEND_API_KEY is set, every send actually goes out via Resend from
// MAIL_FROM (defaults to diary@heldthoughts.com). If it's not set — e.g. on
// a laptop during development — sends fall back to the old simulated
// behavior (logged to the console and to data/sent-mail.log.jsonl) so local
// dev never needs real credentials.
//
// Every send, real or simulated, is also appended to
// data/sent-mail.log.jsonl, so you always have a local record of what went
// out (or would have).
//
// send() deliberately never throws: a passcode reset or a disappearance
// notice should still succeed even if the email provider hiccups. Failures
// are logged instead, with enough detail to debug.
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'sent-mail.log.jsonl');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'diary@heldthoughts.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Held';

let resend = null;
if (RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resend = new Resend(RESEND_API_KEY);
  } catch (e) {
    console.error(
      '[mailer] RESEND_API_KEY is set but the "resend" package could not be loaded (run `npm install`). Falling back to simulated email.',
      e.message
    );
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function appendToSentLog(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

async function send(to, subject, html) {
  if (!to) return { ok: false, reason: 'no recipient' };

  if (!resend) {
    console.log(`[mailer] (simulated — no RESEND_API_KEY set) → ${to} : "${subject}"`);
    appendToSentLog({ to, subject, html, sentAt: Date.now(), simulated: true });
    return { ok: true, simulated: true };
  }

  try {
    const result = await withTimeout(
      resend.emails.send({ from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`, to, subject, html }),
      8000,
      'Resend send()'
    );
    if (result && result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    const providerId = result && result.data && result.data.id;
    console.log(`[mailer] sent via Resend → ${to} : "${subject}"${providerId ? ' (id ' + providerId + ')' : ''}`);
    appendToSentLog({ to, subject, html, sentAt: Date.now(), simulated: false, providerId });
    return { ok: true, simulated: false, providerId };
  } catch (e) {
    console.error(`[mailer] Resend send FAILED → ${to} : "${subject}" — ${e.message}`);
    appendToSentLog({ to, subject, html, sentAt: Date.now(), simulated: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

function tempPasscodeEmail(temp) {
  return `
    <p>Your Held passcode has been reset.</p>
    <p>Your new temporary passcode is: <b style="font-size:1.2em;letter-spacing:1px;">${temp}</b></p>
    <p>Log in with it, and remember: this passcode is also your encryption key.
    Nobody at Held — including any administrator — ever sees it or the entries
    it protects.</p>
    <p>Heads up: any entries written under your old passcode could not be
    carried forward, since the key to unlock them existed only in that old
    passcode.</p>
  `;
}

function disappearanceEmail(mode, hasText, textOrRedacted) {
  const verb = mode === 'fire' ? 'burned away' : 'dissolved like ink';
  const body = hasText
    ? `<pre style="white-space:pre-wrap;font-family:Georgia,serif;">${escapeHtml(textOrRedacted)}</pre>`
    : `<pre style="white-space:pre-wrap;font-family:Georgia,serif;color:#888;">${escapeHtml(textOrRedacted || '')}</pre><p><i>(Text redacted — Held's server never holds your decryption key, so it can only confirm the shape of what disappeared, not the words.)</i></p>`;
  return `<p>An entry just ${verb}.</p>${body}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { send, tempPasscodeEmail, disappearanceEmail };
