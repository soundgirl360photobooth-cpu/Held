// Tiny file-backed store. Good enough for a prototype; swap for Postgres/SQLite
// for real usage. Note what actually lives in here: password verifiers and
// salts (not passcodes), ciphertext + iv for entries (not plaintext), and
// email addresses. Nothing in this file is ever enough, by itself, to read a
// diary entry — that requires the passcode, which this server never stores
// and never sees for user-chosen passcodes (see lib/crypto.js).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

function emptyState() {
  return { users: {}, entries: {}, outbox: {}, prefs: {}, audit: [] };
}

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch (e) {
    return emptyState();
  }
}

const state = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

module.exports = {
  state,
  save,
  pushAudit(action) {
    state.audit.unshift({ action, ts: new Date().toISOString() });
    state.audit = state.audit.slice(0, 200);
  },
};
