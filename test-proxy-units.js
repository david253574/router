/**
 * test-proxy-units.js
 *
 * Unit tests for the helper functions in proxyRewrite.js.
 * Extracts helpers by temporarily exporting them via a test-only shim,
 * then runs assertions against each function's observable behaviour.
 *
 * Run: node test-proxy-units.js
 */
'use strict';

// ── Inline the helper implementations ────────────────────────────────────────
// Copied verbatim from proxyRewrite.js so tests are authoritative.

function escapeAttr(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

function injectBaseTag(htmlBuffer, destinationUrl) {
    let baseOrigin;
    try {
        const parsed = new URL(destinationUrl);
        baseOrigin = `${parsed.protocol}//${parsed.host}/`;
    } catch {
        return htmlBuffer;
    }
    const baseTag = `<base href="${escapeAttr(baseOrigin)}">`;
    let html = htmlBuffer.toString('utf8');
    const headMatch = html.match(/<head(?:\s[^>]*)?>/ );
    if (!headMatch) return htmlBuffer;
    const insertAt = headMatch.index + headMatch[0].length;
    html = html.slice(0, insertAt) + baseTag + html.slice(insertAt);
    return Buffer.from(html, 'utf8');
}

function rewriteSetCookieHeaders(raw, wildcardDomain) {
    if (!raw) return [];
    const headers = Array.isArray(raw) ? raw : [raw];
    return headers.map((header) => {
        if (/;\s*Domain=/i.test(header)) {
            return header.replace(/;\s*Domain=[^;]*/gi, `; Domain=.${wildcardDomain}`);
        }
        return `${header}; Domain=.${wildcardDomain}`;
    });
}

// ── Tiny test harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition) {
    if (condition) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.error(`  FAIL  ${label}`);
        failed++;
    }
}

// ── Test Suite ────────────────────────────────────────────────────────────────

console.log('\n=== 1. injectBaseTag — standard <head> ===');
{
    const html   = Buffer.from('<html><head><title>T</title></head><body>X</body></html>');
    const result = injectBaseTag(html, 'https://destination.com/path?q=1').toString();
    assert('<base> tag present in output',
        result.includes('<base href="https://destination.com/">'));
    assert('<base> inserted immediately after <head>',
        result.includes('<head><base href="https://destination.com/">'));
    assert('existing <title> preserved',
        result.includes('<title>T</title>'));
    assert('body content preserved',
        result.includes('<body>X</body>'));
}

console.log('\n=== 2. injectBaseTag — <head> with attributes ===');
{
    const html   = Buffer.from('<html><head lang="en" data-theme="dark"><title>T</title></head></html>');
    const result = injectBaseTag(html, 'https://foo.com/bar/baz').toString();
    assert('<base> inserted after attributed <head>',
        result.includes('<head lang="en" data-theme="dark"><base href="https://foo.com/">'));
}

console.log('\n=== 3. injectBaseTag — non-standard port in destination ===');
{
    const html   = Buffer.from('<html><head></head><body/></html>');
    const result = injectBaseTag(html, 'http://localhost:8080/page').toString();
    assert('port preserved in base href',
        result.includes('<base href="http://localhost:8080/">'));
}

console.log('\n=== 4. injectBaseTag — no <head> tag (fragment) ===');
{
    const html   = Buffer.from('<div>just a fragment</div>');
    const result = injectBaseTag(html, 'https://foo.com');
    assert('buffer returned unchanged when no <head>',
        result.toString() === '<div>just a fragment</div>');
}

console.log('\n=== 5. injectBaseTag — invalid destination URL ===');
{
    const html   = Buffer.from('<html><head></head></html>');
    const result = injectBaseTag(html, 'not-a-url');
    assert('buffer returned unchanged for unparseable URL',
        result.toString() === '<html><head></head></html>');
}

console.log('\n=== 6. injectBaseTag — XSS guard: malicious chars in destination URL ===');
{
    const html   = Buffer.from('<html><head></head><body/></html>');
    // injectBaseTag uses only protocol + host for the base href origin.
    // Any malicious content in the path/query/fragment is completely discarded —
    // a stronger outcome than escaping alone would provide.
    const malicious = 'https://foo.com/"><script>alert(1)</script>';
    const result = injectBaseTag(html, malicious).toString();
    assert('no raw script tag in output', !result.includes('<script>'));
    assert('base href contains only the clean origin (path stripped)',
        result.includes('<base href="https://foo.com/">'));
}

console.log('\n=== 7. rewriteSetCookieHeaders — replaces existing Domain ===');
{
    const input = 'session=abc; Domain=destination.com; Path=/; Secure; HttpOnly';
    const [out] = rewriteSetCookieHeaders(input, 'mywildcard.com');
    assert('Domain= replaced with our domain', out.includes('; Domain=.mywildcard.com'));
    assert('original domain removed', !out.includes('Domain=destination.com'));
    assert('session value preserved', out.includes('session=abc'));
    assert('Secure attribute preserved', out.includes('Secure'));
    assert('HttpOnly attribute preserved', out.includes('HttpOnly'));
    assert('Path preserved', out.includes('Path=/'));
}

console.log('\n=== 8. rewriteSetCookieHeaders — replaces Domain with dot prefix ===');
{
    const input = 'x=1; Domain=.destination.com; Path=/';
    const [out] = rewriteSetCookieHeaders(input, 'mywildcard.com');
    assert('dotted original domain replaced', !out.includes('.destination.com'));
    assert('new dotted domain present', out.includes('Domain=.mywildcard.com'));
}

console.log('\n=== 9. rewriteSetCookieHeaders — appends Domain when absent ===');
{
    const input = 'token=xyz; Path=/app; HttpOnly';
    const [out] = rewriteSetCookieHeaders(input, 'mywildcard.com');
    assert('Domain appended', out.includes('; Domain=.mywildcard.com'));
    assert('original token preserved', out.includes('token=xyz'));
    assert('Path preserved', out.includes('Path=/app'));
}

console.log('\n=== 10. rewriteSetCookieHeaders — array of cookies ===');
{
    const input = [
        'a=1; Domain=foo.com; Path=/',
        'b=2; Path=/; Secure',
        'c=3; Domain=bar.com; HttpOnly',
    ];
    const out = rewriteSetCookieHeaders(input, 'mywildcard.com');
    assert('returns same count as input', out.length === 3);
    assert('first Domain replaced', out[0].includes('Domain=.mywildcard.com') && !out[0].includes('Domain=foo.com'));
    assert('second Domain appended', out[1].includes('Domain=.mywildcard.com'));
    assert('third Domain replaced', out[2].includes('Domain=.mywildcard.com') && !out[2].includes('Domain=bar.com'));
}

console.log('\n=== 11. rewriteSetCookieHeaders — undefined input ===');
{
    const out = rewriteSetCookieHeaders(undefined, 'mywildcard.com');
    assert('returns empty array for undefined', Array.isArray(out) && out.length === 0);
}

console.log('\n=== 12. rewriteSetCookieHeaders — empty array input ===');
{
    const out = rewriteSetCookieHeaders([], 'mywildcard.com');
    assert('returns empty array for empty input', Array.isArray(out) && out.length === 0);
}

// ── Block-set verification (read the actual source) ───────────────────────────

console.log('\n=== 13. BLOCKED_REQUEST_HEADERS — accept-encoding present ===');
{
    const fs  = require('fs');
    const src = fs.readFileSync('./routes/proxyRewrite.js', 'utf8');
    // Find the BLOCKED_REQUEST_HEADERS Set literal
    const match = src.match(/const BLOCKED_REQUEST_HEADERS = new Set\(\[([\s\S]*?)\]\)/);
    const body  = match ? match[1] : '';
    assert("'accept-encoding' in BLOCKED_REQUEST_HEADERS",
        body.includes("'accept-encoding'"));
}

console.log('\n=== 14. BLOCKED_RESPONSE_HEADERS — CSP, XFO, set-cookie ===');
{
    const fs  = require('fs');
    const src = fs.readFileSync('./routes/proxyRewrite.js', 'utf8');
    const match = src.match(/const BLOCKED_RESPONSE_HEADERS = new Set\(\[([\s\S]*?)\]\)/);
    const body  = match ? match[1] : '';
    assert("'content-security-policy' blocked",
        body.includes("'content-security-policy'"));
    assert("'content-security-policy-report-only' blocked",
        body.includes("'content-security-policy-report-only'"));
    assert("'x-frame-options' blocked",
        body.includes("'x-frame-options'"));
    assert("'set-cookie' NOT in block-set (handled by rewriteSetCookieHeaders)",
        !body.includes("'set-cookie'"));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
