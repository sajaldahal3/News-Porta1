const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanHtml,
  truncate,
  cleanTitle,
  normalizeUrl,
  parseArticleDate,
  isWithinAgeLimit,
  extractImage,
  extractOgImageFromHtml,
  idFromUrl,
  isTransientError,
} = require("../fetch-rss.js");

// --- cleanHtml -----------------------------------------------------------
test("cleanHtml strips tags and decodes common entities", () => {
  const dirty = "<p>Hello &amp; welcome</p><div>to &quot;News&quot;</div>";
  assert.equal(cleanHtml(dirty), 'Hello & welcome to "News"');
});

test("cleanHtml unwraps CDATA sections", () => {
  assert.equal(cleanHtml("<![CDATA[Plain text here]]>"), "Plain text here");
});

test("cleanHtml handles empty/undefined input", () => {
  assert.equal(cleanHtml(""), "");
  assert.equal(cleanHtml(undefined), "");
  assert.equal(cleanHtml(null), "");
});

// --- truncate --------------------------------------------------------------
test("truncate caps length and adds ellipsis", () => {
  const long = "a".repeat(300);
  const result = truncate(long, 250);
  assert.equal(result.length, 251); // 250 chars + ellipsis char
  assert.ok(result.endsWith("…"));
});

test("truncate leaves short text untouched", () => {
  assert.equal(truncate("short text", 250), "short text");
});

// --- cleanTitle --------------------------------------------------------------
test("cleanTitle returns null for whitespace-only titles", () => {
  assert.equal(cleanTitle("   \n\t  "), null);
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle(undefined), null);
});

test("cleanTitle strips HTML from titles", () => {
  assert.equal(cleanTitle("<b>Breaking</b> News"), "Breaking News");
});

test("cleanTitle caps extremely long titles", () => {
  const long = "word ".repeat(200);
  const result = cleanTitle(long, 50);
  assert.ok(result.length <= 51);
  assert.ok(result.endsWith("…"));
});

// --- normalizeUrl --------------------------------------------------------------
test("normalizeUrl strips tracking params and fragments", () => {
  const dirty = "https://example.com/article?utm_source=fb&fbclid=abc&id=5#section2";
  assert.equal(normalizeUrl(dirty), "https://example.com/article?id=5");
});

test("normalizeUrl rejects non-http(s) protocols", () => {
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("ftp://example.com/file"), null);
});

test("normalizeUrl rejects garbage input", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("normalizeUrl treats equivalent URLs identically (dedupe correctness)", () => {
  const a = normalizeUrl("https://example.com/story?utm_source=x&id=1");
  const b = normalizeUrl("https://example.com/story?id=1&utm_medium=y");
  assert.equal(a, b);
});

// --- parseArticleDate / isWithinAgeLimit --------------------------------------------------------------
test("parseArticleDate picks the first valid date field", () => {
  const date = parseArticleDate({ isoDate: "2026-09-01T10:00:00Z" });
  assert.equal(date.getUTCFullYear(), 2026);
});

test("parseArticleDate returns null when no field is parseable", () => {
  assert.equal(parseArticleDate({ isoDate: "not-a-date", pubDate: "also-bad" }), null);
});

test("isWithinAgeLimit treats unknown dates as recent", () => {
  assert.equal(isWithinAgeLimit(null, 48), true);
});

test("isWithinAgeLimit rejects old articles", () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  assert.equal(isWithinAgeLimit(tenDaysAgo, 48), false);
});

test("isWithinAgeLimit accepts recent articles", () => {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000);
  assert.equal(isWithinAgeLimit(oneHourAgo, 48), true);
});

// --- extractImage --------------------------------------------------------------
test("extractImage finds enclosure images", () => {
  const item = { enclosure: { url: "https://example.com/photo.jpg", type: "image/jpeg" } };
  assert.equal(extractImage(item), "https://example.com/photo.jpg");
});

test("extractImage finds media:content images", () => {
  const item = { "media:content": { $: { url: "https://example.com/media.jpg" } } };
  assert.equal(extractImage(item), "https://example.com/media.jpg");
});

test("extractImage finds img src inside HTML content as a fallback", () => {
  const item = { content: '<p>Text</p><img src="https://example.com/inline.png" alt="x">' };
  assert.equal(extractImage(item), "https://example.com/inline.png");
});

test("extractImage prefers data-src over src for lazy-loaded images", () => {
  const item = { content: '<img data-src="https://example.com/real.png" src="placeholder.gif">' };
  assert.equal(extractImage(item), "https://example.com/real.png");
});

test("extractImage returns null when nothing usable is found", () => {
  assert.equal(extractImage({ content: "<p>No images here</p>" }), null);
});

// --- idFromUrl --------------------------------------------------------------
test("idFromUrl is deterministic for the same URL", () => {
  const url = "https://example.com/article";
  assert.equal(idFromUrl(url), idFromUrl(url));
});

test("idFromUrl differs for different URLs", () => {
  assert.notEqual(idFromUrl("https://example.com/a"), idFromUrl("https://example.com/b"));
});

// --- isTransientError --------------------------------------------------------------
test("isTransientError recognizes common transient network errors", () => {
  assert.equal(isTransientError(new Error("connect ECONNRESET")), true);
  assert.equal(isTransientError(new Error("Request timed out")), true);
  assert.equal(isTransientError({ code: "UNAVAILABLE", message: "" }), true);
});

test("isTransientError returns false for permanent errors", () => {
  assert.equal(isTransientError(new Error("Invalid XML syntax")), false);
});

// --- extractOgImageFromHtml --------------------------------------------------------------
test("extractOgImageFromHtml finds a standard og:image tag", () => {
  const html = '<html><head><meta property="og:image" content="https://example.com/thumb.jpg"></head></html>';
  assert.equal(extractOgImageFromHtml(html, "https://example.com/article"), "https://example.com/thumb.jpg");
});

test("extractOgImageFromHtml finds og:image with attributes in reversed order", () => {
  const html = '<meta content="https://example.com/thumb2.jpg" property="og:image">';
  assert.equal(extractOgImageFromHtml(html, "https://example.com/article"), "https://example.com/thumb2.jpg");
});

test("extractOgImageFromHtml falls back to twitter:image when og:image is absent", () => {
  const html = '<meta name="twitter:image" content="https://example.com/tw.jpg">';
  assert.equal(extractOgImageFromHtml(html, "https://example.com/article"), "https://example.com/tw.jpg");
});

test("extractOgImageFromHtml resolves a protocol-relative image URL", () => {
  const html = '<meta property="og:image" content="//example.com/relative.jpg">';
  assert.equal(extractOgImageFromHtml(html, "https://example.com/article"), "https://example.com/relative.jpg");
});

test("extractOgImageFromHtml resolves a path-relative image URL against the page URL", () => {
  const html = '<meta property="og:image" content="/images/pic.jpg">';
  assert.equal(
    extractOgImageFromHtml(html, "https://example.com/news/article-1"),
    "https://example.com/images/pic.jpg"
  );
});

test("extractOgImageFromHtml returns null when no meta image tags exist", () => {
  const html = "<html><head><title>No image here</title></head></html>";
  assert.equal(extractOgImageFromHtml(html, "https://example.com/article"), null);
});

test("extractOgImageFromHtml handles empty input safely", () => {
  assert.equal(extractOgImageFromHtml("", "https://example.com"), null);
  assert.equal(extractOgImageFromHtml(null, "https://example.com"), null);
});
