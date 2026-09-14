/**
 * proxyRewrite.js
 *
 * Internal rewrite (transparent reverse proxy) for the wildcard-subdomain path.
 *
 * Instead of issuing an HTTP 302 redirect — which exposes the destination URL
 * in the browser and changes the address bar — this module fetches the
 * destination server-side and streams the response back to the client.
 * The browser's address bar stays on the wildcard URL throughout.
 *
 * Stack: pure Node.js built-in `http` / `https` modules.
 * No new npm dependencies are introduced.
 *
 * Flow called from server.js (wildcard middleware):
 *   guardSession.onAllow → proxyToDestination(alias, req, res)
 *       ↓
 *   DB lookup  (same SELECT as handleRedirect — active + expiration checks)
 *       ↓ (circuit-break on any failure — 404, no destination exposed)
 *   performProxy(destinationUrl, req, res)
 *       ↓
 *   Follow server-side redirects (max 5) → stream body to client
 *
 * The existing /r/:alias route continues to use handleRedirect() (HTTP 302).
 * This module is only called from the wildcard middleware path.
 */

'use strict';

const http  = require('http');
const https = require('https');
const db    = require('../database');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;

/**
 * Hop-by-hop headers must never be forwarded to the upstream destination.
 * RFC 7230 §6.1 defines the standard set; we also add internal/session headers
 * that belong only to our own infrastructure.
 */
const BLOCKED_REQUEST_HEADERS = new Set([
    // Standard hop-by-hop (RFC 7230)
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    // Routing — set to the destination host inside performProxy
    'host',
    // Do not leak our session cookies to the destination server
    'cookie',
    // Internal rate-limit telemetry
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    // Vercel platform headers (internal infrastructure)
    'x-vercel-id',
    'x-vercel-deployment-url',
    'x-vercel-forwarded-for',
    'x-vercel-ip-org',
]);

/**
 * Response headers from the upstream that must not reach the browser.
 *
 * Reason for each:
 *   set-cookie        — destination cookies would be scoped to our domain
 *   location          — we follow redirects server-side; browser must not see them
 *   transfer-encoding — we stream directly; Express manages its own framing
 *   connection        — hop-by-hop
 *   strict-transport-security — our domain's HSTS is managed by Helmet
 *   alt-svc           — destination's HTTP/3 hints are irrelevant to our domain
 */
const BLOCKED_RESPONSE_HEADERS = new Set([
    'set-cookie',
    'location',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'trailer',
    'upgrade',
    'strict-transport-security',
    'alt-svc',
]);

// ---------------------------------------------------------------------------
// Core proxy engine
// ---------------------------------------------------------------------------

/**
 * performProxy
 *
 * Fetches `targetUrl` using Node's built-in http/https module and pipes
 * the response body directly to `res` (the Express response object).
 * Server-side redirects from the destination are followed transparently,
 * up to MAX_REDIRECTS, so the browser never sees a Location header.
 *
 * @param {string}                     targetUrl      — fully-qualified destination URL
 * @param {import('express').Request}  req            — original inbound Express request
 * @param {import('express').Response} res            — Express response to write into
 * @param {number}                     [redirectCount=0] — internal recursion counter
 */
function performProxy(targetUrl, req, res, redirectCount = 0) {
    // Guard: too many destination-side redirects
    if (redirectCount > MAX_REDIRECTS) {
        if (!res.headersSent) res.status(502).end();
        return;
    }

    // Parse and validate the target URL
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        if (!res.headersSent) res.status(502).end();
        return;
    }

    // Only http: and https: are permitted as proxy destinations
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        if (!res.headersSent) res.status(502).end();
        return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;

    // Build the forwarded header set: safe subset of the original request headers
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
            forwardHeaders[key] = value;
        }
    }
    // Override Host to match the destination — this is essential for
    // virtual-host routing on the destination server
    forwardHeaders['host'] = parsed.hostname;

    const options = {
        hostname: parsed.hostname,
        port:     parsed.port
                    ? Number(parsed.port)
                    : parsed.protocol === 'https:' ? 443 : 80,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  forwardHeaders,
        // 10-second wall-clock timeout; Vercel Pro allows up to 60s
        timeout:  10000,
    };

    const proxyReq = lib.request(options, (proxyRes) => {
        const status = proxyRes.statusCode || 502;

        // Follow destination-side redirects server-side so the browser
        // address bar never changes
        if ([301, 302, 303, 307, 308].includes(status)) {
            // Drain and discard the redirect body
            proxyRes.resume();

            const rawLocation = proxyRes.headers['location'];
            if (!rawLocation) {
                if (!res.headersSent) res.status(502).end();
                return;
            }

            // Resolve relative Location headers against the current URL
            let nextUrl;
            try {
                nextUrl = new URL(rawLocation, targetUrl).toString();
            } catch {
                if (!res.headersSent) res.status(502).end();
                return;
            }

            performProxy(nextUrl, req, res, redirectCount + 1);
            return;
        }

        // ── Stream response to the browser ───────────────────────────────────
        if (res.headersSent) return;

        // Set status code
        res.status(status);

        // Forward filtered upstream headers
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
                try {
                    res.set(key, value);
                } catch {
                    // Ignore any headers Express refuses (e.g. duplicate content-type)
                }
            }
        }

        // Pipe the upstream response body directly to the client.
        // No buffering — keeps memory usage flat for large responses.
        proxyRes.pipe(res);

        proxyRes.on('error', (err) => {
            console.error('[proxyRewrite] upstream response stream error:', err.message);
            if (!res.headersSent) res.status(502).end();
            else res.end();
        });
    });

    // Network-level timeout: destroy the socket and return 504
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).end();
    });

    // Network-level connection error (DNS failure, refused, TLS error, etc.)
    proxyReq.on('error', (err) => {
        console.error('[proxyRewrite] upstream request error:', err.message);
        if (!res.headersSent) res.status(502).end();
    });

    proxyReq.end();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * proxyToDestination
 *
 * Entry point called from the wildcard middleware in server.js (inside the
 * guardSession onAllow callback).
 *
 * Responsibilities:
 *   1. Query the redirects table for the alias (same query as handleRedirect)
 *   2. Enforce active + expiration checks (circuit-break → 404 on any failure)
 *   3. Delegate to performProxy — no HTTP redirect is issued
 *
 * The destination URL is never exposed to the browser.
 * The /r/:alias route is entirely unaffected (still uses handleRedirect → 302).
 *
 * @param {string}                     alias  — extracted alias string
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function proxyToDestination(alias, req, res) {
    db.get(
        `SELECT destination_url, active, expires_at
           FROM redirects
          WHERE LOWER(alias) = LOWER(?)`,
        [alias],
        (err, row) => {
            // Circuit-break: database error
            if (err) {
                console.error('[proxyRewrite] DB error:', err.message);
                return res.status(500).end();
            }

            // Circuit-break: alias not found
            if (!row) {
                return res.status(404).end();
            }

            // Circuit-break: alias administratively disabled
            if (!row.active) {
                return res.status(404).end();
            }

            // Circuit-break: alias past its expiration date
            if (row.expires_at) {
                if (new Date() > new Date(row.expires_at)) {
                    return res.status(404).end();
                }
            }

            // All checks passed — perform internal rewrite.
            // The browser URL remains on the wildcard subdomain.
            performProxy(row.destination_url, req, res);
        }
    );
}

module.exports = { proxyToDestination };
