const express = require('express');
const path = require('path');
const db = require('./lib/db');
const cryptoLib = require('./lib/crypto');
const mailer = require('./lib/mailer');
const scheduler = require('./lib/scheduler');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min sliding
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5000);
const MIN_ENTRY_MINUTES = Number(process.env.MIN_ENTRY_MINUTES || 5); // product default is 5; override only for testing
const CANONICAL_HOST = process.env.CANONICAL_HOST || ''; // e.g. "www.heldthoughts.com" — leave unset until DNS is actually live

const app = express();

// Optional: redirect every other hostname to the canonical one (e.g. bare
// heldthoughts.com -> www.heldthoughts.com, or a platform's *.onrender.com
// preview URL -> the real domain). Off by default so this doesn't break
// testing on a host's preview URL before DNS is pointed at it — set
// CANONICAL_HOST once www.heldthoughts.com is actually live.
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    if (req.hostname && req.hostname !== CANONICAL_HOST) {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    next();
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- in-memory session stores (never persisted, never contain passcodes) ----
const sessions = new Map(); // token -> { username, expiresAt }
const adminSessions = new Map(); // token -> { expiresAt }
const pendingSignups = new Map(); // username -> { email, salt, expiresAt }
const pendingForgot = new Map(); // username -> { salt, expiresAt }  (server-generated temp passcode flow)

function newToken() {
  return cryptoLib.randomHex(24);
}
function cleanupSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expiresAt < now) sessions.delete(t);
  for (const [t, s] of adminSessions) if (s.expiresAt < now) adminSessions.delete(t);
  for (const [u, p] of pendingSignups) if (p.expiresAt < now) pendingSignups.delete(u);
  for (const [u, p] of pendingForgot) if (p.expiresAt < now) pendingForgot.delete(u);
}

function auth(req, res, next) {
  cleanupSessions();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Not logged in.' });
  session.expiresAt = Date.now() + SESSION_TTL_MS; // sliding expiry
  req.username = session.username;
  next();
}

function adminAuth(req, res, next) {
  cleanupSessions();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && adminSessions.get(token);
  if (!session) return res.status(401).json({ error: 'Not logged in as admin.' });
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  next();
}

// ============================= signup (2-step, zero-knowledge) =============================
app.post('/api/signup/init', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (db.state.users[username]) {
    return res.status(409).json({ error: 'That username is taken.' });
  }
  const salt = cryptoLib.randomHex(16);
  pendingSignups.set(username, { email, salt, expiresAt: Date.now() + 10 * 60 * 1000 });
  res.json({ salt });
});

app.post('/api/signup/complete', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const verifier = String(req.body.verifier || '');
  const pending = pendingSignups.get(username);
  if (!pending) return res.status(400).json({ error: 'Signup expired or not started — try again.' });
  db.state.users[username] = { salt: pending.salt, verifier, email: pending.email, createdAt: Date.now() };
  db.state.prefs[username] = { includeText: true };
  db.save();
  pendingSignups.delete(username);
  res.json({ ok: true });
});

// ============================= login (2-step, zero-knowledge) =============================
app.post('/api/login/init', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const u = db.state.users[username];
  if (!u) return res.status(404).json({ error: 'No such user, or wrong passcode.' });
  res.json({ salt: u.salt });
});

app.post('/api/login/complete', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const verifier = String(req.body.verifier || '');
  const u = db.state.users[username];
  if (!u || u.verifier !== verifier) {
    return res.status(401).json({ error: 'No such user, or wrong passcode.' });
  }
  const token = newToken();
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token });
});

app.post('/api/logout', auth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ============================= forgot passcode (self-service, email-verified) =============================
app.post('/api/forgot-passcode', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.state.users[username];

  // Always the same response, whether or not the account/email matched —
  // avoids letting this endpoint be used to enumerate accounts.
  const genericMsg = { ok: true, message: 'If that username and email match an account, a new temporary passcode has been emailed.' };

  if (u && u.email && u.email === email) {
    const temp = cryptoLib.randomPasscode();
    const salt = cryptoLib.randomHex(16);
    const { verifier } = await cryptoLib.deriveFromPasscode(temp, salt);
    db.state.users[username] = { ...u, salt, verifier };
    db.pushAudit(`Self-service passcode reset for "${username}"`);
    db.save();
    // Fire-and-forget: don't make the caller wait on email delivery, and
    // don't let a slow/broken provider turn into a slow/broken reset.
    mailer.send(u.email, 'Your Held passcode was reset', mailer.tempPasscodeEmail(temp));
  }

  res.json(genericMsg);
});

// ============================= admin =============================
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const passcode = String(req.body.passcode || '');
  if (username !== ADMIN_USER || passcode !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  const token = newToken();
  adminSessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token });
});

app.post('/api/admin/reset', adminAuth, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const u = db.state.users[username];
  if (!u) return res.status(404).json({ error: 'No such user.' });

  const temp = cryptoLib.randomPasscode();
  const salt = cryptoLib.randomHex(16);
  const { verifier } = await cryptoLib.deriveFromPasscode(temp, salt);
  db.state.users[username] = { ...u, salt, verifier };
  db.pushAudit(`Admin reset passcode for "${username}"`);
  db.save();
  mailer.send(u.email, 'Your Held passcode was reset by an administrator', mailer.tempPasscodeEmail(temp));

  // The admin gets a confirmation, never the passcode and never the full email.
  res.json({ ok: true, maskedEmail: cryptoLib.maskEmail(u.email) });
});

app.get('/api/admin/audit', adminAuth, (req, res) => {
  res.json({ audit: db.state.audit.slice(0, 50) });
});

// Full username + email list, for account records / outreach. Deliberately
// separate from everything else an admin can do: it exposes real email
// addresses (unmasked, unlike the reset confirmation above), so it's logged
// to the audit trail every time it's viewed. It never includes passcodes,
// verifiers, salts, or anything about entry content — those remain
// inaccessible to admins under any endpoint.
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = Object.keys(db.state.users)
    .map((username) => ({
      username,
      email: db.state.users[username].email || null,
      createdAt: db.state.users[username].createdAt || null,
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  db.pushAudit(`Admin viewed the full user list (${users.length} accounts)`);
  db.save();

  res.json({ users, total: users.length });
});

// ============================= entries =============================
app.get('/api/entries', auth, (req, res) => {
  res.json({ entries: db.state.entries[req.username] || [] });
});

app.post('/api/entries', auth, (req, res) => {
  const { iv, cipher, mode } = req.body;
  const minutes = Number(req.body.minutes);
  if (!iv || !cipher) return res.status(400).json({ error: 'Missing encrypted payload.' });
  if (!['fire', 'ink'].includes(mode)) return res.status(400).json({ error: 'Invalid mode.' });
  if (!Number.isFinite(minutes) || minutes < MIN_ENTRY_MINUTES || minutes > 1440) {
    return res.status(400).json({ error: `Duration must be between ${MIN_ENTRY_MINUTES} and 1440 minutes.` });
  }
  const now = Date.now();
  const entry = {
    id: 'e' + now + Math.random().toString(36).slice(2, 7),
    iv,
    cipher,
    createdAt: now,
    expiresAt: now + minutes * 60000,
    mode,
  };
  const list = db.state.entries[req.username] || (db.state.entries[req.username] = []);
  list.push(entry);
  db.save();
  res.json({ entry });
});

// Client calls this the moment IT notices (locally) that an entry expired —
// i.e. the app was open. Because it already decrypted the entry to animate
// it, it can optionally hand back the plaintext/redacted text so the
// notification is rich instead of generic. This also removes the ciphertext
// immediately so the background scheduler doesn't process it a second time.
app.delete('/api/entries/:id', auth, (req, res) => {
  const list = db.state.entries[req.username] || [];
  const idx = list.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Entry not found (already gone?).' });
  const entry = list[idx];
  list.splice(idx, 1);

  const text = typeof req.body.text === 'string' ? req.body.text : null;
  const redacted = typeof req.body.redacted === 'string' ? req.body.redacted : null;
  const user = db.state.users[req.username];

  const outboxList = db.state.outbox[req.username] || (db.state.outbox[req.username] = []);
  outboxList.unshift({
    id: 'n' + Date.now() + Math.random().toString(36).slice(2, 7),
    to: user ? user.email : null,
    subject: 'Your entry has disappeared',
    mode: entry.mode,
    text,
    redacted,
    approxLen: (redacted || text || '').length || undefined,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    sentAt: Date.now(),
    source: 'client',
  });
  db.state.outbox[req.username] = outboxList.slice(0, 30);
  db.save();

  if (user && user.email) {
    mailer.send(
      user.email,
      'Your entry has disappeared',
      mailer.disappearanceEmail(entry.mode, !!text, text || redacted)
    );
  }

  res.json({ ok: true });
});

// ============================= outbox + prefs =============================
app.get('/api/outbox', auth, (req, res) => {
  res.json({ outbox: db.state.outbox[req.username] || [] });
});

app.get('/api/prefs', auth, (req, res) => {
  res.json({ prefs: db.state.prefs[req.username] || { includeText: true } });
});

app.post('/api/prefs', auth, (req, res) => {
  db.state.prefs[req.username] = { includeText: !!req.body.includeText };
  db.save();
  res.json({ ok: true });
});

// ============================= account deletion =============================
// Requires re-proving the passcode (via the same verifier scheme as login),
// not just an active session token — a stolen/leaked bearer token alone
// shouldn't be enough to permanently destroy an account. Deletion is
// immediate and total: user record, every entry (already just ciphertext),
// outbox history, and prefs. It's logged to the audit trail as an action
// only, same as every other audit entry — never any entry content.
app.delete('/api/account', auth, (req, res) => {
  const username = req.username;
  const u = db.state.users[username];
  const verifier = String(req.body.verifier || '');
  if (!u || u.verifier !== verifier) {
    return res.status(401).json({ error: 'Passcode did not match — account was not deleted.' });
  }

  delete db.state.users[username];
  delete db.state.entries[username];
  delete db.state.outbox[username];
  delete db.state.prefs[username];
  db.pushAudit(`Account and all data deleted (self-service) for "${username}"`);
  db.save();

  // Kill every active session for this user, not just the one making the request.
  for (const [t, s] of sessions) if (s.username === username) sessions.delete(t);

  res.json({ ok: true });
});

// ============================= boot =============================
app.listen(PORT, () => {
  console.log(`Held backend listening on http://localhost:${PORT}`);
  console.log('⚠️  This is a plain-HTTP dev server. Put it behind HTTPS before it ever sees a real passcode.');
  scheduler.start(SCHEDULER_INTERVAL_MS);
  console.log(`Background clock sweeping every ${SCHEDULER_INTERVAL_MS}ms.`);
});

module.exports = app;
