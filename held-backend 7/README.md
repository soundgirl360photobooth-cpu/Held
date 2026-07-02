# Held — backend

This is the backend-connected version of Held. The earlier prototype was a
single HTML file that kept everything in the browser's local storage — which
meant an entry could only "expire" while that exact browser tab was open.
This version adds a real server with its own clock, so entries disappear on
schedule whether or not anyone has the app open.

## What's here

```
held-backend/
├── server.js          Express app: auth, entries, admin, outbox routes
├── lib/
│   ├── db.js           Tiny JSON-file store (swap for a real DB later)
│   ├── crypto.js       PBKDF2 / random-passcode / email-masking helpers
│   ├── mailer.js       Simulated email sender (logs instead of delivering)
│   └── scheduler.js    The clock: sweeps for expired entries every few seconds
└── public/
    └── index.html      The client (same look and animations as before)
```

## Running it locally

```
npm install
npm start
```

Then open `http://localhost:3000`. Data is stored in `data/db.json`, and a
record of every simulated email is appended to `data/sent-mail.log.jsonl` so
you can see exactly what would have gone out.

Environment variables (see `.env.example`): `PORT`, `ADMIN_USER`, `ADMIN_PASS`,
`SCHEDULER_INTERVAL_MS`.

## What changed from the single-file prototype

- **Signup and login now happen in two steps**, so your passcode itself is
  never sent to the server in any form — only a one-way PBKDF2 verifier
  derived from it, computed in your browser. This is the same property the
  original prototype had; it just now works over a network instead of only
  inside one browser's storage.
- **"Forgot your passcode?" is on the login screen.** Enter your username and
  the email on file; if they match, the server generates a random temporary
  passcode, emails it to you, and never shows it to anyone else — not even
  itself, in the sense that it's discarded from memory immediately after
  being logged for the simulated send.
- **Admin resets work the same way**: an admin can trigger a reset for a
  username, but the server generates the new passcode and emails it directly
  to the user. The admin only ever sees a masked email address
  (`so***@example.com`) as confirmation — never the passcode, never the full
  address, never any entry content.
- **A real background clock (`lib/scheduler.js`)** sweeps all entries every
  few seconds and deletes any that have expired, regardless of whether a
  browser is connected. This is the actual fix for "the app has to be open
  for anything to happen."

## The honest limitation: what the clock can and can't notify you about

The server is built so it **never holds a decryption key for your entries
unless you're actively using the app in that moment.** That's a deliberate
trade-off, not an oversight, and it means:

- If the app is open when an entry hits its deadline, your browser decrypts
  it locally, plays the burn/dissolve animation, and sends the server a rich
  notification (the real text, or a redacted stand-in shaped like it, if
  you've turned off "include entry text"). This is identical to how the
  single-file prototype behaved.
- If the app is **closed** when an entry expires, the background clock still
  deletes the ciphertext right on schedule — that part is now solid — but it
  can only log a generic notification (which mode, roughly how long the
  entry was) because it has no key and never asks for one. You'll see it
  labeled "server clock" in the Outbox, versus "live in-app" for the rich
  ones.

In other words: **deletion is now always on time. Rich, exact-content
notifications are still opportunistic**, because giving the server standing
access to your key so it could always produce them would mean the server
(and whoever operates it) could read your entries at any moment — which
directly contradicts the "admin can never read entries" goal from day one.
If you'd rather trade some of that privacy for always-rich notifications, the
change would be: cache each user's derived key server-side for the lifetime
of their login session (not just their passcode-verification step), and have
the scheduler use it opportunistically too. That's a real option — just not
the default here, and worth a deliberate decision rather than a silent one.

## Email: real delivery via Resend

`lib/mailer.js` now sends real email through [Resend](https://resend.com)
when `RESEND_API_KEY` is set, using `diary@heldthoughts.com` as the sender by
default. Without a key, it quietly falls back to the old simulated behavior
(logged to the console and to `data/sent-mail.log.jsonl`) so local dev never
needs real credentials. Every send — real or simulated — still gets appended
to that log file, so you always have a record of what went out. A failed
send is logged and swallowed rather than thrown, so a flaky email provider
can never break a passcode reset or a disappearance notice.

To turn it on:

1. **Set the environment variable** `RESEND_API_KEY` to your Resend API key
   (in `.env` locally, or your host's secret/environment settings when
   deployed). Never commit it — `.env` is already git-ignored.
2. **Verify `heldthoughts.com` as a sending domain** in the Resend
   dashboard (Domains → Add Domain). Resend will show you a set of DNS
   records (typically an MX record and a few TXT/CNAME records for SPF and
   DKIM) to add at whichever registrar or DNS host manages heldthoughts.com.
   Sending from `diary@heldthoughts.com` won't work — Resend will reject or
   silently fail it — until that domain shows as verified, which can take
   anywhere from a few minutes to a couple of days depending on DNS
   propagation.
3. **`MAIL_FROM` and `MAIL_FROM_NAME`** already default to
   `diary@heldthoughts.com` and `Held`, so once the domain is verified and
   the API key is set, no further code changes are needed. Override either
   in `.env` if you'd rather send from a different address under the same
   domain (e.g. `notifications@heldthoughts.com`).

Note that `www.heldthoughts.com` (where you'd presumably point this app
itself) and the domain verification for *sending* mail are separate
concerns — verifying `heldthoughts.com` for Resend doesn't require the app
to be hosted there, and hosting the app at `www.heldthoughts.com` doesn't by
itself enable sending. Both need to be set up, but independently.

**Update:** this is now confirmed working end to end — `heldthoughts.com` is
verified in Resend, and a real passcode-reset email sent successfully from
`diary@heldthoughts.com` during testing. No further setup needed there
beyond keeping `RESEND_API_KEY` set wherever you deploy.

## Attaching www.heldthoughts.com

`heldthoughts.com` is on GoDaddy nameservers (`ns41`/`ns42.domaincontrol.com`).
To point `www.heldthoughts.com` at wherever you deploy this:

1. **Deploy first, get a target address.** Render/Railway/Fly.io will each
   give you either a URL to CNAME to, or an IP to point an A record at, once
   the app is deployed there — check that platform's custom domain docs. A
   VPS gives you a static IP directly.
2. **Add the DNS record in GoDaddy** (Domains → DNS → Manage Zones for
   heldthoughts.com): typically a `CNAME` record for the `www` host pointing
   at the target the platform gave you, or an `A` record if you're using a
   VPS with a static IP.
3. **Add `www.heldthoughts.com` as a custom domain** in your hosting
   platform's dashboard too, if it's Render/Railway/Fly — most won't route
   traffic for a domain they don't know about, even once DNS points at them,
   and they'll typically also issue the HTTPS certificate for it
   automatically once both sides are set up.
4. **Once it's live**, set `CANONICAL_HOST=www.heldthoughts.com` (see
   `.env.example`) so any other hostname — a bare `heldthoughts.com`, or the
   platform's own `*.onrender.com`-style URL — redirects to it. Leave this
   unset until DNS is actually pointed there, or you'll redirect yourself
   away from the only URL that currently works while testing.

## Deploying somewhere real

This needs to run as a long-lived process, not a static file host. Reasonable
options, roughly ordered by effort:

- **Render / Railway / Fly.io** — connect the repo, set the environment
  variables from `.env.example`, deploy. All three give you HTTPS
  automatically, which is not optional here (see below).
- **A VPS** — run it with `pm2` or a systemd service so it restarts if it
  crashes, and put it behind a reverse proxy (Caddy or nginx) for TLS. Caddy
  in particular will get you a free HTTPS certificate with almost no config.

Whichever you choose: **this must run behind HTTPS before it ever sees a real
passcode.** Right now it's a plain-HTTP dev server — fine on localhost, not
fine on the open internet.

## Account deletion

Users can permanently delete their own account and all associated data from
inside the app ("Delete my account and data," in the diary screen). It
requires re-entering the passcode (re-verified server-side, the same way
login is) plus typing DELETE, so a stolen session token alone isn't enough to
trigger it. Deletion removes the user record, every entry, notification
history, and preferences, and invalidates every active session for that
account — logged to the audit trail as an action only, same as every other
audit entry. There's no recovery path afterward, on purpose.

## Legal pages

`public/privacy.html` and `public/terms.html` are linked from the app's
footer and served automatically (same static folder as everything else).
**Read the comment at the top of each file before publishing them** — they're
accurate drafts of what this codebase actually does, not legal advice, and
they have bracketed placeholders (legal entity name, governing law) that need
filling in. Get an actual lawyer to review both before real users rely on
them, especially if you'll have users outside the US.

## Known limitations worth knowing about

- **Storage**: `data/db.json` is a flat file, fine for a prototype, not for
  real concurrent load or durability guarantees. Swap in Postgres or SQLite
  before this holds anyone's actual diary.
- **Username enumeration**: `/api/login/init` returns 404 for an unknown
  username, which technically confirms whether an account exists. The
  forgot-passcode endpoint deliberately avoids this (same response either
  way); login could be hardened the same way later if you want that too.
- **Sessions are in-memory**: restarting the server logs everyone out. Fine
  for a prototype; a real deployment would want sessions in Redis or similar
  if you run more than one server process.
- **No rate limiting** on login/signup/forgot endpoints yet — add some
  before this is public.
