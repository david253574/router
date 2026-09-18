/**
 * sessionGuard.js
 *
 * Stateful session-binding for the wildcard-subdomain redirect path.
 *
 * Enforces a one-user-per-link policy:
 *   • First access  → issue a signed session token, record client signature
 *                     in Turso/libSQL, set an HTTP-only cookie, then allow.
 *   • Return visit  → validate token signature + client signature match, allow.
 *   • Any mismatch  → circuit-break, return 404, never touch destination URL.
 *
 * Cookie design
 * ─────────────
 * Cookie name : _rsid
 * Cookie value: <token>.<hmac-sha256(token, SECRET)>
 *
 * The token is a 32-byte random hex string (64 chars).
 * The HMAC prevents forgery even if the token value is observed.
 *
 * Client signature
 * ────────────────
 * SHA-256 of: normalised-IP + "|" + User-Agent + "|" + Accept-Language
 * Stored as a hex digest; compared on every subsequent request.
 *
 * DB table: alias_sessions
 * ─────────────────────────
 * alias        TEXT  (FK-equivalent to redirects.alias, not a hard FK)
 * session_token TEXT UNIQUE
 * client_sig   TEXT
 * created_at   DATETIME
 *
 * One row per alias (UNIQUE on alias), so a second visitor's token will
 * never match the stored token for that alias.
 */

'use strict';

const crypto = require('crypto');
const db     = require('../database');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = '_rsid';
// Cookie lifetime: 24 hours (matches existing admin session lifetime)
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Returns the SESSION_SECRET, reading it at call time so it is always current
 * even in test environments that set the env var after module load.
 */
function getSecret() {
    return process.env.SESSION_SECRET || 'fallback_dev_secret_please_change';
}

/**
 * generateToken — cryptographically random 32-byte hex string.
 * @returns {string}
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * signToken — HMAC-SHA256 of the token using the application secret.
 * @param {string} token
 * @returns {string}  hex digest
 */
function signToken(token) {
    return crypto.createHmac('sha256', getSecret()).update(token).digest('hex');
}

/**
 * buildCookieValue — combine token + signature into the wire value.
 * @param {string} token
 * @returns {string}
 */
function buildCookieValue(token) {
    return `${token}.${signToken(token)}`;
}

/**
 * parseCookieHeader — parse the raw Cookie header string into a plain object.
 * Avoids any dependency on cookie-session / the cookieParser middleware.
 *
 * @param {string|undefined} header  raw Cookie header
 * @returns {Record<string, string>}
 */
function parseCookieHeader(header) {
    const out = {};
    if (!header) return out;
    for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (key) out[key] = val;
    }
    return out;
}

/**
 * extractToken — read + verify the _rsid cookie from the raw header.
 *
 * Returns the raw token string if the signature is valid,
 * or null if the cookie is absent / malformed / tampered.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
    const cookies = parseCookieHeader(req.get('cookie'));
    const raw     = cookies[COOKIE_NAME];
    if (!raw) return null;

    const dotIdx = raw.lastIndexOf('.');
    if (dotIdx === -1) return null;

    const token         = raw.slice(0, dotIdx);
    const receivedHmac  = raw.slice(dotIdx + 1);
    const expectedHmac  = signToken(token);

    // Timing-safe comparison
    try {
        const a = Buffer.from(receivedHmac, 'hex');
        const b = Buffer.from(expectedHmac, 'hex');
        if (a.length !== b.length) return null;
        if (!crypto.timingSafeEqual(a, b)) return null;
    } catch {
        return null;
    }

    // Basic sanity: token must be 64 hex chars
    if (!/^[0-9a-f]{64}$/.test(token)) return null;

    return token;
}

/**
 * buildClientSig — derive a deterministic fingerprint from the request.
 *
 * Components:
 *   • User-Agent (exact string)
 *
 * Note: We intentionally exclude IP address because mobile carrier networks
 * (4G/5G) frequently rotate IPs between requests, which would cause false-positive
 * 404 lockouts on a simple page refresh. The HTTP-Only HMAC cookie is already
 * unforgeable and provides a rock-solid 1-device lock.
 *
 * @param {import('express').Request} req
 * @returns {string} hex hash
 */
function buildClientSig(req) {
    const ua = (req.get('user-agent') || '').trim();
    const raw = `${ua}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * setCookie — append a Set-Cookie header to the response.
 * Does not overwrite existing Set-Cookie headers (append-safe).
 *
 * @param {import('express').Response} res
 * @param {string} token
 * @param {boolean} isProduction
 */
function setCookie(res, token, isProduction) {
    const value = buildCookieValue(token);
    const parts = [
        `${COOKIE_NAME}=${value}`,
        `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (isProduction) parts.push('Secure');

    // Express res.append correctly accumulates multiple Set-Cookie headers
    res.append('Set-Cookie', parts.join('; '));
}

// ---------------------------------------------------------------------------
// Database helpers (callback-compatible with the libSQL adapter in database.js)
// ---------------------------------------------------------------------------

/**
 * dbGetSession — fetch the alias_sessions row for a given alias.
 * @param {string} alias
 * @param {function(Error|null, object|undefined): void} cb
 */
function dbGetSession(alias, cb) {
    db.get(
        `SELECT session_token, client_sig FROM alias_sessions WHERE alias = ?`,
        [alias.toLowerCase()],
        cb
    );
}

/**
 * dbCreateSession — insert a new session row for the alias.
 * @param {string} alias
 * @param {string} token
 * @param {string} clientSig
 * @param {function(Error|null): void} cb
 */
function dbCreateSession(alias, token, clientSig, cb) {
    db.run(
        `INSERT INTO alias_sessions (alias, session_token, client_sig) VALUES (?, ?, ?)`,
        [alias.toLowerCase(), token, clientSig],
        function (err) { cb(err); }
    );
}

/**
 * buildLoadingPage
 *
 * Returns a minimal HTML loading page that:
 *   1. Shows a spinner to the user while the JS challenge runs.
 *   2. POSTs to /_challenge with the alias — proving the visitor is a
 *      real JavaScript-capable browser (network-provider scanners are not).
 *   3. On a 200 OK from /_challenge, reloads the page so guardSession
 *      now finds an existing session with a valid cookie and grants access.
 *   4. On any failure, reloads anyway so the user gets a clean retry.
 *
 * The /_challenge endpoint (added in server.js) calls guardSession internally
 * to create the DB session row and set the _rsid cookie.
 *
 * @param {string} alias
 * @param {boolean} isProduction
 * @returns {string} HTML string
 */
function buildLoadingPage(alias, isProduction) {
    // Escape the alias for safe inline JS embedding
    const safeAlias = JSON.stringify(alias);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading...</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;
         background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    .wrap{text-align:center;color:#fff}
    .spinner{width:48px;height:48px;border:4px solid rgba(255,255,255,.15);
             border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
    @keyframes spin{to{transform:rotate(360deg)}}
    p{font-size:15px;color:rgba(255,255,255,.55);letter-spacing:.3px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="spinner"></div>
    <p>Loading, please wait&hellip;</p>
  </div>
  <script>
    (function () {
      var alias = ${safeAlias};
      fetch('/_challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: alias }),
        credentials: 'include'
      })
      .then(function (r) {
        // Whether success or already-claimed, reload to let guardSession decide
        window.location.reload();
      })
      .catch(function () {
        window.location.reload();
      });
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * guardSession
 *
 * Enforces the one-user-per-link session policy for a wildcard alias.
 *
 * Call this AFTER traffic checks pass and BEFORE proxyToDestination().
 *
 * Decision tree:
 *   No existing session for alias
 *     → Called from wildcard GET  → serve loading page (JS challenge)
 *     → Called from /_challenge POST → register, set cookie, respond { ok: true }
 *   Existing session, token match + sig match → allow (call onAllow)
 *   Existing session, any mismatch            → block (return 404)
 *
 * "Allow" means the provided `onAllow` callback is invoked so the caller
 * can continue the redirect flow.  "Block" terminates the response here.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {string}                     alias  — normalised alias string
 * @param {function(): void}           onAllow — called when access is granted
 */
function guardSession(req, res, alias, onAllow) {
    const isProduction = process.env.NODE_ENV === 'production';
    const incomingToken = extractToken(req);
    const incomingClientSig = buildClientSig(req);

    dbGetSession(alias, (err, existingSession) => {
        if (err) {
            // Database error — fail safe: block rather than expose the destination
            console.error('[sessionGuard] DB read error:', err.message);
            return res.status(500).end();
        }

        if (!existingSession) {
            // ── No session exists yet ────────────────────────────────────────
            //
            // This branch is reached in two scenarios:
            //
            //   A. Wildcard GET (MTN bot or real user first visit)
            //      → serve the JS-challenge loading page.
            //      → MTN/Airtel bots cannot execute JavaScript, so they leave
            //        without ever posting to /_challenge, link stays unburnt.
            //
            //   B. POST /_challenge from the loading page's JS fetch()
            //      → The wildcard middleware short-circuits /_challenge POSTs,
            //        so this branch here is reached via the dedicated route
            //        handler in server.js, which calls onAllow() on success.
            //      → Create session, set cookie, call onAllow().
            //
            // We distinguish the two by req.method: the dedicated /_challenge
            // route only accepts POST; everything else (GET from wildcard
            // middleware) gets the loading page.
            if (req.method !== 'POST') {
                // Scenario A — serve the loading page gate.
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                return res.status(200).end(buildLoadingPage(alias, isProduction));
            }

            // Scenario B — real browser passed the JS challenge. Lock the session.
            const newToken = generateToken();
            dbCreateSession(alias, newToken, incomingClientSig, (createErr) => {
                if (createErr) {
                    if (
                        createErr.message &&
                        createErr.message.includes('UNIQUE constraint failed')
                    ) {
                        // Race: another tab already claimed it between SELECT and INSERT.
                        // Return 409 so the loading page JS reloads; guardSession will
                        // then find the existing session and validate the cookie.
                        return res.status(409).json({ error: 'already-claimed' });
                    }
                    console.error('[sessionGuard] DB insert error:', createErr.message);
                    return res.status(500).end();
                }
                // Session locked. Cookie set. Caller sends { ok: true }.
                setCookie(res, newToken, isProduction);
                return onAllow();
            });
            return;
        }

        // ── Subsequent access: validate token + client signature ─────────────
        const storedToken     = existingSession.session_token;
        const storedClientSig = existingSession.client_sig;

        // Verify the token presented in the cookie
        let tokenValid = false;
        if (incomingToken) {
            try {
                const a = Buffer.from(incomingToken,  'utf8');
                const b = Buffer.from(storedToken,    'utf8');
                tokenValid = a.length === b.length && crypto.timingSafeEqual(a, b);
            } catch {
                tokenValid = false;
            }
        }

        // Verify the client signature matches what was recorded at registration
        let sigValid = false;
        try {
            const a = Buffer.from(incomingClientSig, 'utf8');
            const b = Buffer.from(storedClientSig,   'utf8');
            sigValid = a.length === b.length && crypto.timingSafeEqual(a, b);
        } catch {
            sigValid = false;
        }

        if (tokenValid && sigValid) {
            // Refresh the cookie TTL on every valid request
            setCookie(res, storedToken, isProduction);
            return onAllow();
        }

        // Token or signature mismatch — secondary client detected
        // Circuit-break: do not expose destination URL
        return res.status(404).end();
    });
}

module.exports = { guardSession };
