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
 *   DB lookup  (active + expiration checks — circuit-break on any failure → 404)
 *       ↓
 *   performProxy(destinationUrl, req, res)
 *       ↓
 *   Follow server-side redirects (max 5)
 *       ↓
 *   text/html  → buffer → inject <base> tag → send
 *   everything → pipe directly (no buffering)
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
 * Request headers that must never be forwarded to the upstream destination.
 *
 * accept-encoding is explicitly blocked so the upstream always returns
 * identity (uncompressed) content.  This is required for correct HTML
 * buffering and <base> tag injection — injecting into a gzip stream would
 * produce a corrupt document.  Non-HTML assets (images, fonts, binary files)
 * are never compressed by content-negotiation anyway, so the bandwidth impact
 * is negligible.
 */
const BLOCKED_REQUEST_HEADERS = new Set([
    // Standard hop-by-hop (RFC 7230 §6.1)
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    // Overridden to the destination hostname inside performProxy
    'host',
    // Never leak our _rsid session cookie or admin session to the destination
    'cookie',
    // Force identity encoding so we can safely buffer and modify HTML
    'accept-encoding',
    // Internal rate-limit counters — irrelevant to the destination
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    // Vercel internal platform headers
    'x-vercel-id',
    'x-vercel-deployment-url',
    'x-vercel-forwarded-for',
    'x-vercel-ip-org',
]);

/**
 * Response headers from the upstream that must not reach the browser.
 *
 * set-cookie  — handled separately via rewriteSetCookieHeaders(); NOT here.
 * location    — consumed server-side when following redirects; never exposed.
 * content-length — managed explicitly after HTML injection changes body size.
 *
 * content-security-policy / content-security-policy-report-only:
 *   Upstream CSP rules reference the destination origin (e.g. example.com).
 *   They would block scripts and styles from loading inside our wildcard
 *   window environment, breaking page functionality.  Stripped entirely.
 *
 * x-frame-options:
 *   SAMEORIGIN / DENY from the upstream would prevent the document from
 *   rendering inside any framed context on our domain.  Stripped.
 *
 * strict-transport-security / alt-svc:
 *   Our domain's HSTS and protocol-upgrade hints are managed by Helmet.
 */
const BLOCKED_RESPONSE_HEADERS = new Set([
    // Hop-by-hop
    'connection',
    'keep-alive',
    'trailer',
    'upgrade',
    'transfer-encoding',
    // Redirects are followed server-side; browser must never see Location
    'location',
    // Managed explicitly per response type (HTML vs binary)
    'content-length',
    // CSP: destination-domain rules break execution in our wildcard context
    'content-security-policy',
    'content-security-policy-report-only',
    // Upstream CORS directives must be overridden with permissive ones
    'access-control-allow-origin',
    // Framing restriction from the upstream does not apply to our domain
    'x-frame-options',
    // Infrastructure headers managed by Helmet
    'strict-transport-security',
    'alt-svc',
    // set-cookie is NOT in this set — it is processed by rewriteSetCookieHeaders()
]);

// ---------------------------------------------------------------------------
// Helper: <base> tag injection
// ---------------------------------------------------------------------------

/**
 * escapeAttr
 *
 * Minimal attribute-value escaping for the href in the injected <base> tag.
 * Prevents a maliciously crafted destination URL from breaking the tag.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

/**
 * injectBaseTag
 *
 * Inserts `<base href="https://destination.com/">` immediately after the
 * opening <head> tag in an HTML document buffer.
 *
 * Effect on the browser:
 *   Every relative asset path in the document — /css/app.css, /js/main.js,
 *   ../images/logo.png — is resolved against the destination origin rather
 *   than our wildcard root.  This repairs broken layouts, styles, and scripts
 *   without rewriting individual href/src attributes throughout the HTML.
 *
 * Edge cases handled:
 *   • <head> with attributes:  <head lang="en" data-theme="dark">
 *   • No <head> tag present (document fragment) → returns buffer unchanged
 *
 * @param {Buffer} htmlBuffer     — raw (uncompressed) HTML body
 * @param {string} destinationUrl — fully-qualified destination URL
 * @returns {Buffer}              — modified HTML body
 */
function injectBaseTag(htmlBuffer, destinationUrl) {
    let baseOrigin;
    let parsed;
    try {
        parsed = new URL(destinationUrl);
        // Use protocol + host (includes port if non-standard) + trailing slash
        baseOrigin = `${parsed.protocol}//${parsed.host}/`;
    } catch {
        // Unparseable destination URL — return the buffer unmodified
        return htmlBuffer;
    }

    // Single Page Applications (React, Vue) read window.location to determine state.
    // If the destination requires query parameters (?token=...) or specific paths (/receiver.html),
    // we must silently sync the browser's address bar to match those expectations
    // while keeping the wildcard domain perfectly masked.
    let stateScript = '';
    const injectedPath = parsed.pathname + parsed.search;
    if (injectedPath !== '/') {
        stateScript = `<script>
            if (window.location.pathname + window.location.search !== ${JSON.stringify(injectedPath)}) {
                // Prepend window.location.origin to force an absolute URL.
                window.history.replaceState(null, '', window.location.origin + ${JSON.stringify(injectedPath)});
            }
        </script>`;
    }

    // We no longer inject a <base> tag because it forces the browser to bypass the proxy
    // for API calls, triggering strict CORS blocks on the destination server.
    const injection = stateScript;

    let html = htmlBuffer.toString('utf8');

    // 1. Strip internal Meta CSP tags that block asset fetching and inline execution
    html = html.replace(/<meta[^>]+http-equiv=['"]?Content-Security-Policy['"]?[^>]*>/gi, '');

    // 2. Remove Subresource Integrity (SRI) attributes to prevent asset rejection
    html = html.replace(/\s+integrity=['"][^'"]+['"]/gi, '');

    // Match the first <head> tag, allowing for any attributes
    const headMatch = html.match(/<head(?:\s[^>]*)?>/ );
    if (!headMatch) {
        // No <head> tag — document fragment or unusual structure; return sanitized html
        return Buffer.from(html, 'utf8');
    }

    const insertAt = headMatch.index + headMatch[0].length;
    html = html.slice(0, insertAt) + injection + html.slice(insertAt);
    return Buffer.from(html, 'utf8');
}

// ---------------------------------------------------------------------------
// Helper: Set-Cookie domain rewriting
// ---------------------------------------------------------------------------

/**
 * rewriteSetCookieHeaders
 *
 * Rewrites the Domain attribute of upstream Set-Cookie headers so that
 * cookies are scoped to the wildcard domain rather than the destination domain.
 *
 * Without rewriting, the browser would reject these cookies because the
 * Set-Cookie Domain does not match the address-bar domain (alias.yourdomain.com).
 *
 * Behaviour:
 *   • If Domain=<anything> is present  → replaced with Domain=.<wildcardDomain>
 *   • If no Domain attribute is present → Domain=.<wildcardDomain> is appended
 *
 * Leading dot on the domain (`.yourdomain.com`) follows RFC 6265 §4.1.2.3
 * and allows the cookie to be sent to all subdomains of wildcardDomain.
 *
 * @param {string|string[]|undefined} raw           — upstream Set-Cookie value(s)
 * @param {string}                    wildcardDomain — e.g. "yourdomain.com"
 * @returns {string[]}                              — rewritten Set-Cookie strings
 */
function rewriteSetCookieHeaders(raw, wildcardDomain) {
    if (!raw) return [];

    const headers = Array.isArray(raw) ? raw : [raw];

    return headers.map((header) => {
        // Replace an existing Domain= directive (case-insensitive, any value)
        if (/;\s*Domain=/i.test(header)) {
            return header.replace(
                /;\s*Domain=[^;]*/gi,
                `; Domain=.${wildcardDomain}`
            );
        }
        // No Domain directive present — append one
        return `${header}; Domain=.${wildcardDomain}`;
    });
}

// ---------------------------------------------------------------------------
// Core proxy engine
// ---------------------------------------------------------------------------

/**
 * performProxy
 *
 * Fetches targetUrl and delivers the response to the browser with:
 *
 *   text/html responses
 *     • Fully buffered (required for <base> injection)
 *     • <base href="..."> injected immediately after the opening <head> tag
 *     • Correct content-length set after injection
 *
 *   All other content types (JS, CSS, images, JSON, fonts, …)
 *     • Piped directly to the browser with zero buffering
 *     • content-length forwarded from the upstream unchanged
 *
 *   All responses
 *     • Server-side redirect following (301/302/303/307/308, max 5 hops)
 *     • Set-Cookie domain rewritten to wildcardDomain
 *     • CSP, X-Frame-Options, HSTS stripped
 *     • Upstream session cookies never sent to destination
 *
 * @param {string}                     targetUrl
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {number}                     [redirectCount=0]
 */
function performProxy(targetUrl, req, res, redirectCount = 0) {
    // Guard: abort if the destination keeps redirecting indefinitely
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

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        if (!res.headersSent) res.status(502).end();
        return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;

    // Build the outbound header set: forward a safe subset of the client's headers.
    // accept-encoding is stripped (see BLOCKED_REQUEST_HEADERS comment above).
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
            forwardHeaders[key] = value;
        }
    }
    // The destination must receive its own hostname — required for virtual-host
    // routing (SNI, HTTP/1.1 Host header).
    forwardHeaders['host'] = parsed.hostname;

    // Origin and Referer Spoofing
    if (forwardHeaders['origin']) {
        forwardHeaders['origin'] = parsed.origin;
    }
    if (forwardHeaders['referer']) {
        try {
            const refUrl = new URL(forwardHeaders['referer']);
            refUrl.protocol = parsed.protocol;
            refUrl.host = parsed.host;
            forwardHeaders['referer'] = refUrl.toString();
        } catch {
            forwardHeaders['referer'] = parsed.origin + '/';
        }
    }

    // Handle body for non-GET/HEAD/OPTIONS requests that were parsed by express.json
    let bodyStr = null;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        if (req._body && req.body && typeof req.body === 'object') {
            bodyStr = JSON.stringify(req.body);
            forwardHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
        }
    }

    const options = {
        hostname: parsed.hostname,
        port:     parsed.port
                      ? Number(parsed.port)
                      : parsed.protocol === 'https:' ? 443 : 80,
        path:     parsed.pathname + parsed.search,
        method:   req.method,
        headers:  forwardHeaders,
        // 10-second wall-clock timeout (Vercel Pro limit is 60 s)
        timeout:  10000,
    };

    // Resolve the wildcard domain for Set-Cookie rewriting.
    // In production this is REDIRECT_BASE_DOMAIN; in dev it falls back to localhost.
    const wildcardDomain =
        process.env.REDIRECT_BASE_DOMAIN ||
        (process.env.NODE_ENV !== 'production' ? 'localhost' : null);

    const proxyReq = lib.request(options, (proxyRes) => {
        const status = proxyRes.statusCode || 502;

        // ── Server-side redirect following ────────────────────────────────────
        if ([301, 302, 303, 307, 308].includes(status)) {
            // Drain and discard the redirect body to free the socket
            proxyRes.resume();

            const rawLocation = proxyRes.headers['location'];
            if (!rawLocation) {
                if (!res.headersSent) res.status(502).end();
                return;
            }

            // Resolve relative Location values against the current URL
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

        // ── Deliver response to browser ───────────────────────────────────────
        if (res.headersSent) return;

        // Strip global Helmet security headers that conflict with the proxied site
        res.removeHeader('content-security-policy');
        res.removeHeader('x-frame-options');
        res.removeHeader('x-content-type-options');
        res.removeHeader('strict-transport-security');

        res.status(status);

        // Unconditionally force permissive CORS for all assets (fonts, scripts, css)
        res.set('access-control-allow-origin', '*');

        // Forward filtered upstream headers
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lkey = key.toLowerCase();

            // Skip headers that are fully blocked
            if (BLOCKED_RESPONSE_HEADERS.has(lkey)) continue;

            // Set-Cookie: rewrite Domain attribute before forwarding
            if (lkey === 'set-cookie') {
                if (wildcardDomain) {
                    for (const cookie of rewriteSetCookieHeaders(value, wildcardDomain)) {
                        res.append('Set-Cookie', cookie);
                    }
                }
                // If no wildcard domain is resolvable, drop the Set-Cookie header
                // rather than forward a cookie the browser would reject
                continue;
            }

            try {
                res.set(key, value);
            } catch {
                // Ignore headers Express refuses (e.g. already-set Content-Type)
            }
        }

        // ── Branch on content type ────────────────────────────────────────────
        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');

        if (isHtml) {
            // Buffer the full HTML body so we can inject the <base> tag.
            // Memory usage is bounded by the size of the HTML document itself;
            // binary assets (images, video) are never buffered (see else-branch).
            const chunks = [];

            proxyRes.on('data', (chunk) => {
                chunks.push(chunk);
            });

            proxyRes.on('end', () => {
                if (res.headersSent) return;

                const raw      = Buffer.concat(chunks);
                const modified = injectBaseTag(raw, targetUrl);

                // Set the correct content-length after injection expands the body
                res.set('content-length', String(modified.length));
                res.end(modified);
            });

            proxyRes.on('error', (err) => {
                console.error('[proxyRewrite] HTML buffer error:', err.message);
                if (!res.headersSent) res.status(502).end();
            });

        } else {
            // Non-HTML: stream bytes directly to the client with zero buffering.
            // Forward the upstream content-length so the browser can show progress.
            const upstreamLength = proxyRes.headers['content-length'];
            if (upstreamLength) res.set('content-length', upstreamLength);

            proxyRes.pipe(res);

            proxyRes.on('error', (err) => {
                console.error('[proxyRewrite] upstream response stream error:', err.message);
                if (!res.headersSent) res.status(502).end();
                else res.end();
            });
        }
    });

    // Network-level timeout: destroy the socket cleanly and return 504
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).end();
    });

    // Network-level error: DNS failure, connection refused, TLS error, etc.
    proxyReq.on('error', (err) => {
        console.error('[proxyRewrite] upstream request error:', err.message);
        if (!res.headersSent) res.status(502).end();
    });

    // Body dispatch
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        if (bodyStr !== null) {
            proxyReq.write(bodyStr);
            proxyReq.end();
        } else if (req._body) {
            // Body was consumed by body-parser but wasn't a standard JSON object
            proxyReq.end();
        } else {
            // Stream unparsed body
            req.pipe(proxyReq);
        }
    } else {
        proxyReq.end();
    }
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
 *   1. Query the redirects table for the alias
 *   2. Enforce active + expiration checks
 *   3. Circuit-break with 404 on any validation failure
 *   4. Delegate to performProxy — no HTTP redirect is ever issued
 *
 * The destination URL is never sent to the browser.
 * The /r/:alias route is entirely unaffected (still uses handleRedirect → 302).
 *
 * @param {string}                     alias
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
            if (err) {
                console.error('[proxyRewrite] DB error:', err.message);
                return res.status(500).end();
            }

            // Circuit-break: alias not found
            if (!row) return res.status(404).end();

            // Circuit-break: alias administratively disabled
            if (!row.active) return res.status(404).end();

            // Circuit-break: alias past its expiration date
            if (row.expires_at && new Date() > new Date(row.expires_at)) {
                return res.status(404).end();
            }

            // All checks passed — perform internal rewrite.
            // The browser URL remains on the wildcard subdomain.
            let finalTarget = row.destination_url;
            if (req.url && req.url !== '/') {
                try {
                    const destUrl = new URL(finalTarget);
                    // Critical: Resolve relative paths (like /api/... or /css/...) against the 
                    // origin of the destination, NOT by appending to query strings.
                    finalTarget = destUrl.origin + req.url;
                } catch {
                    const base = finalTarget.endsWith('/') ? finalTarget.slice(0, -1) : finalTarget;
                    finalTarget = base + req.url;
                }
            }
            performProxy(finalTarget, req, res);
        }
    );
}

module.exports = { proxyToDestination };
