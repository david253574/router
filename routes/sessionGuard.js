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
 *   • Client IP  (req.ip honours Express trust-proxy setting)
 *   • User-Agent (exact string)
 *   • Accept-Language (normalised to lower-case for minor variation tolerance)
 *
 * @param {import('express').Request} req
 * @returns {string}  hex SHA-256 digest
 */
function buildClientSig(req) {
    const ip   = (req.ip || req.connection?.remoteAddress || '').trim();
    const ua   = (req.get('user-agent')   || '').trim();
    const lang = (req.get('accept-language') || '').toLowerCase().trim();

    const raw = `${ip}|${ua}|${lang}`;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * guardSession
 *
 * Enforces the one-user-per-link session policy for a wildcard alias.
 *
 * Call this AFTER traffic checks pass and BEFORE handleRedirect().
 *
 * Decision tree:
 *   No existing session for alias  → register, allow
 *   Existing session, token match + sig match → allow
 *   Existing session, any mismatch → block (return 404)
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
            // ── First access: register this client as the session owner ──────
            const newToken = generateToken();

            dbCreateSession(alias, newToken, incomingClientSig, (createErr) => {
                if (createErr) {
                    // Race condition: another request registered between our
                    // SELECT and our INSERT.  Treat as a duplicate access attempt.
                    if (
                        createErr.message &&
                        createErr.message.includes('UNIQUE constraint failed')
                    ) {
                        return res.status(404).end();
                    }
                    console.error('[sessionGuard] DB insert error:', createErr.message);
                    return res.status(500).end();
                }

                // Issue cookie and allow the redirect to proceed
                setCookie(res, newToken, isProduction);
                return onAllow();
            });

            return; // wait for async callback
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
