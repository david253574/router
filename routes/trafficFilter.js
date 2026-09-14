/**
 * trafficFilter.js
 *
 * Enterprise traffic filtering for the wildcard-subdomain redirect path.
 *
 * Implements three independent signal layers:
 *   1. Cloud / data-centre network detection via known AS-organisation keywords
 *      surfaced by Vercel's x-vercel-ip-org (or similar CDN headers) and the
 *      Cloudflare cf-ipcountry / cf-iporgname family when present.
 *   2. Automated User-Agent identification.
 *   3. Browser header anomaly / signature mismatch detection.
 *
 * IMPORTANT: If any signal fires, the caller must terminate the request
 * immediately — before handleRedirect() is invoked — so that the
 * Turso/libSQL database is never queried for blocked traffic.
 *
 * Returns:
 *   { blocked: false }
 *   { blocked: true, reason: '<short reason string>' }
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. Cloud & Data-Centre Network Detection
// ---------------------------------------------------------------------------

/**
 * ASN organisation name keywords that indicate a commercial cloud provider,
 * hosting company, or known data-centre network.
 *
 * Vercel injects `x-vercel-ip-org` containing the ASN org name string for
 * each inbound request.  Cloudflare exposes `cf-ipcountry` / `cf-ray` and
 * sometimes `cf-connecting-ip`; some Cloudflare Worker setups also add an
 * org string.  We match case-insensitively against the raw org string.
 */
const DATACENTER_ORG_KEYWORDS = [
    // Amazon Web Services
    'amazon', 'aws', 'ec2',
    // Google Cloud / GCP
    'google', 'googlebot', 'gcp',
    // Microsoft Azure
    'microsoft', 'azure',
    // DigitalOcean
    'digitalocean',
    // Hetzner
    'hetzner',
    // Akamai / Linode
    'akamai', 'linode',
    // OVH / Scaleway
    'ovh', 'scaleway',
    // Vultr
    'vultr',
    // Oracle Cloud
    'oracle',
    // Cloudflare (tunnel/bot traffic, NOT consumer CF edge)
    'cloudflare',
    // Generic hosting / VPS keywords
    'hosting', 'datacenter', 'data center', 'data centre', 'colocation',
    'colo', 'server', 'dedicated', 'vps', 'virtual private',
];

/**
 * Headers that CDN/proxy layers inject with the upstream ASN org name.
 * Checked in priority order; the first non-empty value is used.
 */
const ORG_HEADERS = [
    'x-vercel-ip-org',       // Vercel injects this automatically
    'cf-ipcountry-org',      // Cloudflare (non-standard but seen in some setups)
    'x-real-ip-org',
];

/**
 * isDatacenterNetwork
 *
 * Inspects ASN-org headers for cloud/hosting keywords.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isDatacenterNetwork(req) {
    // Collect org string from whichever header is present
    let orgStr = '';
    for (const header of ORG_HEADERS) {
        const val = req.get(header);
        if (val && val.trim()) {
            orgStr = val.trim().toLowerCase();
            break;
        }
    }

    if (!orgStr) return false;

    for (const keyword of DATACENTER_ORG_KEYWORDS) {
        if (orgStr.includes(keyword)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// 2. Automated User-Agent Identification
// ---------------------------------------------------------------------------

/**
 * Exact-token and substring patterns for automated/non-browser clients.
 * Matched case-insensitively against the full User-Agent string.
 */
const BLOCKED_UA_PATTERNS = [
    // ── Command-line utilities ───────────────────────────────────────────
    /\bcurl\b/i,
    /\bwget\b/i,
    /\bhttpie\b/i,
    /\baxios\b/i,
    /\bgot\//i,           // sindresorhus/got
    /\bnode-fetch\b/i,
    /\bpython-requests\b/i,
    /\bpython-urllib\b/i,
    /\bgo-http-client\b/i,
    /\bjava\//i,
    /\bapache-httpclient\b/i,
    /\blibwww-perl\b/i,
    /\bwww-mechanize\b/i,

    // ── Headless / automation frameworks ────────────────────────────────
    /headlesschrome/i,
    /\bpuppeteer\b/i,
    /\bplaywright\b/i,
    /\bselenium\b/i,
    /\bphantomjs\b/i,
    /\bsplash\b/i,         // Scrapy Splash
    /\bhttrack\b/i,

    // ── Generic bot / scraper keywords ──────────────────────────────────
    /\bbot\b/i,
    /\bcrawler\b/i,
    /\bspider\b/i,
    /\bscraper\b/i,
    /\bfetcher\b/i,
    /\barchiver\b/i,
    /\bmonitor\b/i,

    // ── Commercial SEO / audit tools ────────────────────────────────────
    /\bahrefs\b/i,
    /\bsemrush\b/i,
    /\bmj12bot\b/i,        // Majestic
    /\bdotbot\b/i,
    /\bblexbot\b/i,
    /\bsistersbot\b/i,
    /screaming.?frog/i,
    /\bnetsystemsresearch\b/i,
    /\bpingdom\b/i,
    /\buptimerobot\b/i,
    /\bstatuscake\b/i,

    // ── Search-engine bots ───────────────────────────────────────────────
    /googlebot/i,
    /bingbot/i,
    /slurp/i,              // Yahoo Slurp
    /duckduckbot/i,
    /baiduspider/i,
    /yandexbot/i,

    // ── Empty / missing UA (trivially automated) ────────────────────────
    // Handled separately in isAutomatedUA so we can check for empty string
];

/**
 * isAutomatedUA
 *
 * Returns true if the User-Agent is absent or matches a known automated client.
 *
 * @param {string} ua  — raw User-Agent header value (may be empty string)
 * @returns {boolean}
 */
function isAutomatedUA(ua) {
    // Absent / trivially short UA
    if (!ua || ua.trim().length < 10) return true;

    for (const pattern of BLOCKED_UA_PATTERNS) {
        if (pattern.test(ua)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// 3. Browser Header Anomaly / Signature Mismatch Detection
// ---------------------------------------------------------------------------

/**
 * Modern browsers (Chrome 89+, Edge 89+, Firefox, Safari) send a predictable
 * set of headers.  Automated tools that spoof a browser UA frequently omit
 * these, or set them inconsistently.
 *
 * We apply two checks:
 *   A. Structural completeness — the request must include at least one of the
 *      required headers that every real browser sends.
 *   B. Signature mismatch — if the UA claims to be a Chromium-family browser
 *      (Chrome, Edge, Brave) it MUST carry the `sec-ch-ua` client-hint header
 *      that Chromium has sent by default since v89.  Its absence while
 *      claiming to be Chrome/Edge is a strong automation indicator.
 */

/**
 * Headers that every real modern browser includes on page navigations.
 * At least ONE must be present for the request to be considered browser-like.
 */
const REQUIRED_BROWSER_HEADERS = [
    'accept-language',   // Every browser sets this
    'accept',            // Every browser sets this
];

/**
 * hasBrowserHeaderAnomaly
 *
 * Returns true if the request looks like it is masquerading as a browser but
 * lacks the structural headers that browsers always send.
 *
 * Only applied when the UA *appears* to be a browser (not already caught by
 * isAutomatedUA), so we don't double-count.
 *
 * @param {string} ua  — raw User-Agent header value
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasBrowserHeaderAnomaly(ua, req) {
    // ── A. Structural completeness ───────────────────────────────────────
    const hasRequiredHeader = REQUIRED_BROWSER_HEADERS.some(
        (h) => !!(req.get(h) && req.get(h).trim())
    );
    if (!hasRequiredHeader) return true;

    // ── B. Chromium sec-ch-ua mismatch ──────────────────────────────────
    // Chrome ≥ 89 and Edge ≥ 89 always send `sec-ch-ua`.
    // Detecting "Chrome/" or "Edg/" in UA without sec-ch-ua = spoofed UA.
    const isChromiumUA = /\b(Chrome|Chromium|Edg|Brave)\//i.test(ua);
    if (isChromiumUA) {
        const hasSecChUa = !!(req.get('sec-ch-ua') && req.get('sec-ch-ua').trim());
        if (!hasSecChUa) return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * checkTraffic
 *
 * Runs all three filter layers in order.  Returns on the first positive
 * signal to keep overhead minimal.
 *
 * Callers MUST NOT invoke handleRedirect() or any DB call when
 * result.blocked === true.
 *
 * @param {import('express').Request} req
 * @returns {{ blocked: boolean, reason?: string }}
 */
function checkTraffic(req) {
    const ua = req.get('User-Agent') || '';

    // Layer 1 — Cloud / data-centre network
    if (isDatacenterNetwork(req)) {
        return { blocked: true, reason: 'datacenter-network' };
    }

    // Layer 2 — Automated User-Agent
    if (isAutomatedUA(ua)) {
        return { blocked: true, reason: 'automated-ua' };
    }

    // Layer 3 — Browser header anomaly (only for UAs that passed layer 2)
    if (hasBrowserHeaderAnomaly(ua, req)) {
        return { blocked: true, reason: 'header-anomaly' };
    }

    return { blocked: false };
}

module.exports = { checkTraffic };
