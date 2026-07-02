// The actual "clock". Runs on its own timer, independent of any HTTP request
// or open browser tab. Every sweep, it deletes ciphertext for any entry whose
// time is up — this is the real fix for "an entry should be gone at its
// deadline, not just next time someone opens the app."
//
// It can NEVER produce a full-content notification, on purpose: this server
// has no decryption key for entries it didn't just receive over an active,
// logged-in session (see server.js) — and even then, live sessions don't
// hand their key to the scheduler. So a background sweep only knows an
// entry's mode and its ciphertext length, never its words. If the app was
// open at the moment an entry expired, the client handles it itself (decrypts,
// animates, and reports a rich notification) and the scheduler simply finds
// nothing left to do for that entry.
const db = require('./db');
const mailer = require('./mailer');

function sweepOnce() {
  const now = Date.now();
  let changed = false;

  for (const username of Object.keys(db.state.entries)) {
    const list = db.state.entries[username] || [];
    const remaining = [];

    for (const entry of list) {
      if (entry.expiresAt <= now) {
        changed = true;

        // AES-GCM ciphertext = plaintext bytes + 16-byte auth tag.
        const cipherBytes = Buffer.from(entry.cipher, 'hex').length;
        const approxLen = Math.max(0, cipherBytes - 16);

        const user = db.state.users[username];
        const outboxList = db.state.outbox[username] || (db.state.outbox[username] = []);
        outboxList.unshift({
          id: 'n' + now + Math.random().toString(36).slice(2, 7),
          to: user ? user.email : null,
          subject: 'Your entry has disappeared',
          mode: entry.mode,
          text: null,
          redacted: null,
          approxLen,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          sentAt: now,
          source: 'scheduler',
        });
        db.state.outbox[username] = outboxList.slice(0, 30);

        if (user && user.email) {
          const placeholder = '•'.repeat(Math.min(approxLen, 400));
          mailer.send(
            user.email,
            'Your entry has disappeared',
            mailer.disappearanceEmail(entry.mode, false, placeholder)
          );
        }
      } else {
        remaining.push(entry);
      }
    }
    db.state.entries[username] = remaining;
  }

  if (changed) db.save();
}

function start(intervalMs = 5000) {
  sweepOnce(); // catch up on anything that expired while the server was down
  return setInterval(sweepOnce, intervalMs);
}

module.exports = { start, sweepOnce };
