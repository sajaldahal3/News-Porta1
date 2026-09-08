/**
 * fetch-rss.js  (hardened version)
 *
 * Fetches a list of RSS feeds in parallel and writes NEW articles into
 * Firestore. Safe to run on a tight schedule (every 5 minutes) via GitHub
 * Actions — dedupe is atomic (Firestore create()), per-article failures
 * are isolated, transient network/Firestore errors are retried, and
 * source health is tracked separately from whether a source is enabled.
 *
 * Run locally with:  node fetch-rss.js
 * Run tests with:    npm test
 */

const admin = require("firebase-admin");
const Parser = require("rss-parser");
const crypto = require("crypto");

// =======================================================================
// 1. CONFIG
// =======================================================================

// "enabled" controls whether this source is processed at all (config).
// "lastFetchStatus" (written to Firestore per run) reflects live health —
// the two are intentionally separate so a temporarily-broken feed doesn't
// need to be removed from the list, and so the admin panel can eventually
// flip "enabled" per source once sources move into Firestore itself.
const SOURCES = [
  { id: "ronbpost", name: "RONB Post", category: "Nepal", rssUrl: "https://www.ronbpost.com/feed/", enabled: true },
  { id: "ratopati", name: "Ratopati", category: "Nepal", rssUrl: "https://www.ratopati.com/feed", enabled: true },
  { id: "setopati", name: "Setopati", category: "Nepal", rssUrl: "https://www.setopati.com/feed", enabled: true },
  { id: "onlinekhabar", name: "Online Khabar", category: "Nepal", rssUrl: "https://www.onlinekhabar.com/feed", enabled: true },
  { id: "nepalnews", name: "Nepal News", category: "Nepal", rssUrl: "https://nepalnews.com/feed/", enabled: true },
  // Add more sources below the same way, each as its own { } object:
  // { id: "bbc-world", name: "BBC World", category: "World", rssUrl: "https://feeds.bbci.co.uk/news/world/rss.xml", enabled: true },
];

const SNIPPET_MAX_LENGTH = 1000;      // hard cap per your copyright/crediting rules
const TITLE_MAX_LENGTH = 300;
const DEFAULT_MAX_ITEMS_PER_SOURCE = 50;   // cap per run, per source
const DEFAULT_MAX_ARTICLE_AGE_HOURS = 48;  // don't import old backlog items
const SOURCE_CONCURRENCY = 4;        // how many feeds to fetch at once
const ARTICLE_CONCURRENCY = 5;       // how many articles to write at once, per source
const FETCH_TIMEOUT_MS = 15000;

const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

// =======================================================================
// 2. SMALL GENERIC UTILITIES (pure functions — see tests/util.test.js)
// =======================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn`, retrying on transient errors with exponential backoff. */
async function withRetry(fn, { retries = 3, baseDelayMs = 500, isRetryable = isTransientError } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 150;
      await sleep(delay);
    }
  }
}

function isTransientError(err) {
  const msg = String((err && err.message) || "").toLowerCase();
  const code = err && (err.code || err.status);
  const transientHints = [
    "502", "503", "504", "timeout", "timed out", "econnreset", "econnrefused",
    "enotfound", "eai_again", "network", "socket hang up",
  ];
  const transientFirestoreCodes = ["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", 4, 8, 14];
  return (
    transientHints.some((h) => msg.includes(h)) ||
    transientFirestoreCodes.includes(code)
  );
}

/** Maps `items` through `mapper` with at most `concurrency` running at once. */
async function mapWithConcurrency(items, mapper, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Strips HTML tags and decodes the handful of entities RSS feeds commonly use. */
function cleanHtml(rawHtml) {
  if (!rawHtml) return "";
  let text = String(rawHtml);
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); // unwrap CDATA
  text = text.replace(/<\/?(p|div|br|li)[^>]*>/gi, " ");     // block tags -> space
  text = text.replace(/<[^>]+>/g, "");                        // strip remaining tags
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  return text.replace(/\s+/g, " ").trim();
}

function truncate(cleanText, max) {
  if (!cleanText) return "";
  return cleanText.length > max ? cleanText.slice(0, max).trim() + "…" : cleanText;
}

/** Cleans + validates a title. Returns null if nothing usable remains. */
function cleanTitle(rawTitle, max = TITLE_MAX_LENGTH) {
  const cleaned = cleanHtml(rawTitle);
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max).trim() + "…" : cleaned;
}

/** Validates + normalizes a URL: http(s) only, no fragment, no tracking params. */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

/** Tries several common RSS date fields; returns a valid Date or null. */
function parseArticleDate(item) {
  const candidates = [item.isoDate, item.pubDate, item.date];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Returns true if the article should be considered "recent enough" to import.
 *  Unknown/unparseable dates are treated as recent (we'd rather keep an
 *  article than silently drop it just because a feed's date format is odd). */
function isWithinAgeLimit(date, maxAgeHours) {
  if (!date) return true;
  const ageMs = Date.now() - date.getTime();
  return ageMs <= maxAgeHours * 3600 * 1000;
}

/** Finds the best available image URL from an RSS item, across the many
 *  shapes different feeds use, and normalizes it. */
function extractImage(item) {
  const candidates = [];

  if (item.enclosure) {
    const enclosures = Array.isArray(item.enclosure) ? item.enclosure : [item.enclosure];
    for (const enc of enclosures) {
      if (enc && enc.url && (!enc.type || enc.type.startsWith("image"))) candidates.push(enc.url);
    }
  }

  for (const field of ["media:content", "media:thumbnail"]) {
    const value = item[field];
    if (!value) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const url = entry && entry["$"] && entry["$"].url;
      if (url) candidates.push(url);
    }
  }

  if (item.image) {
    if (typeof item.image === "string") candidates.push(item.image);
    else if (item.image.url) candidates.push(item.image.url);
  }

  const html = item["content:encoded"] || item.content || item.summary || item.contentSnippet || "";
  if (html) {
    const patterns = [
      /<img[^>]+data-src=["']([^"']+)["']/i,
      /<img[^>]+data-lazy-src=["']([^"']+)["']/i,
      /<img[^>]+src=["']([^"']+)["']/i,
      /<img[^>]+srcset=["']([^"'\s]+)/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) candidates.push(match[1]);
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/** Deterministic Firestore-safe document ID from a normalized URL. */
function idFromUrl(normalizedUrl) {
  return crypto.createHash("sha256").update(normalizedUrl).digest("hex");
}

// =======================================================================
// 3. FIREBASE INIT
// =======================================================================

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT environment variable. " +
        "Set it to the full contents of your Firebase service account JSON."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  }

  const requiredFields = ["project_id", "client_email", "private_key"];
  const missing = requiredFields.filter((field) => !serviceAccount[field]);
  if (missing.length > 0) {
    // Never log the credential contents themselves — only which fields are missing.
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is missing required field(s): ${missing.join(", ")}`);
  }

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

// =======================================================================
// 4. FIRESTORE WRITE HELPERS
// =======================================================================

/**
 * Atomically writes an article only if it doesn't already exist.
 * Uses create() instead of get()+set() so two overlapping runs can never
 * both "see no existing doc" and double-write — Firestore rejects the
 * second create() with an ALREADY_EXISTS error, which we treat as a skip.
 */
async function createArticleIfNew(db, docId, data) {
  const ref = db.collection("articles").doc(docId);
  try {
    await withRetry(() => ref.create(data));
    return "added";
  } catch (err) {
    const isAlreadyExists =
      err && (err.code === 6 || err.code === "already-exists" || /ALREADY_EXISTS/i.test(err.message || ""));
    if (isAlreadyExists) return "skipped";
    throw err;
  }
}

async function writeSourceHealth(db, source, health) {
  await withRetry(() =>
    db.collection("sources").doc(source.id).set(
      {
        name: source.name,
        category: source.category,
        rssUrl: source.rssUrl,
        enabled: source.enabled !== false,
        lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastFetchStatus: health.status,
        lastFetchError: health.error || null,
        lastRunCounts: {
          attempted: health.attempted,
          added: health.added,
          skipped: health.skipped,
          invalidAge: health.invalidAge,
          invalidData: health.invalidData,
          failed: health.failed,
        },
      },
      { merge: true }
    )
  );
}

// =======================================================================
// 5. PER-ARTICLE PROCESSING (fully isolated — one bad item never
//    stops the rest of the feed from being processed)
// =======================================================================

async function processArticle(db, source, item, health, maxAgeHours) {
  try {
    const originalUrl = normalizeUrl(item.link);
    if (!originalUrl) {
      health.invalidData++;
      return;
    }

    const title = cleanTitle(item.title);
    if (!title) {
      health.invalidData++;
      return;
    }

    const publishedDate = parseArticleDate(item);
    if (!isWithinAgeLimit(publishedDate, maxAgeHours)) {
      health.invalidAge++;
      return;
    }

    const rawSnippetSource = item.contentSnippet || item.summary || item.content || item["content:encoded"] || "";
    const snippet = truncate(cleanHtml(rawSnippetSource), SNIPPET_MAX_LENGTH);
    const imageUrl = extractImage(item);
    const docId = idFromUrl(originalUrl);

    const publishedAt = publishedDate
      ? admin.firestore.Timestamp.fromDate(publishedDate)
      : admin.firestore.FieldValue.serverTimestamp();

    const result = await createArticleIfNew(db, docId, {
      sourceId: source.id,
      sourceName: source.name,
      category: source.category,
      title,
      snippet,
      imageUrl,
      originalUrl,
      publishedAt,
      ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
      likeCount: 0,
      saveCount: 0,
      hidden: false,
    });

    health[result]++; // "added" or "skipped"
  } catch (err) {
    health.failed++;
    console.error(`  ✗ ${source.name}: failed to process an article:`, err.message);
  }
}

// =======================================================================
// 6. PER-SOURCE INGESTION
// =======================================================================

async function ingestSource(db, parser, source) {
  const health = {
    status: "ok",
    error: null,
    attempted: 0,
    added: 0,
    skipped: 0,
    invalidAge: 0,
    invalidData: 0,
    failed: 0,
  };

  console.log(`Fetching: ${source.name} (${source.rssUrl})`);

  try {
    const feed = await withRetry(() =>
      parser.parseURL(source.rssUrl).then((result) => {
        // rss-parser doesn't apply our timeout by itself in all environments;
        // Parser is already constructed with a timeout option, this is a safety net.
        return result;
      })
    );

    if (!feed || !Array.isArray(feed.items)) {
      throw new Error("Feed response did not contain a valid items array");
    }

    const maxItems = source.maxItems || DEFAULT_MAX_ITEMS_PER_SOURCE;
    const maxAgeHours = source.maxAgeHours || DEFAULT_MAX_ARTICLE_AGE_HOURS;
    const items = feed.items.slice(0, maxItems);
    health.attempted = items.length;

    await mapWithConcurrency(
      items,
      (item) => processArticle(db, source, item, health, maxAgeHours),
      ARTICLE_CONCURRENCY
    );

    console.log(
      `  ✓ ${source.name}: ${health.added} new, ${health.skipped} already existed, ` +
        `${health.invalidAge} too old, ${health.invalidData} invalid, ${health.failed} failed`
    );
  } catch (err) {
    health.status = "error";
    health.error = err.message;
    console.error(`  ✗ ${source.name}: fetch failed —`, err.message);
  } finally {
    try {
      await writeSourceHealth(db, source, health);
    } catch (healthErr) {
      // Never let a health-write failure mask the real ingestion result.
      console.error(`  ✗ ${source.name}: failed to write health status:`, healthErr.message);
    }
  }

  return health;
}

// =======================================================================
// 7. MAIN
// =======================================================================

async function main() {
  const db = initFirebase();
  const parser = new Parser({
    timeout: FETCH_TIMEOUT_MS,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsPortalBot/1.0)" },
  });

  const activeSources = SOURCES.filter((source) => source.enabled !== false);
  if (activeSources.length === 0) {
    console.log("No enabled sources to process.");
    return;
  }

  const results = await mapWithConcurrency(
    activeSources,
    (source) => ingestSource(db, parser, source),
    SOURCE_CONCURRENCY
  );

  const totals = results.reduce(
    (acc, r) => ({
      added: acc.added + r.added,
      skipped: acc.skipped + r.skipped,
      failed: acc.failed + r.failed,
      errored: acc.errored + (r.status === "error" ? 1 : 0),
    }),
    { added: 0, skipped: 0, failed: 0, errored: 0 }
  );

  console.log(
    `\nDone. ${totals.added} new article(s) added, ${totals.skipped} skipped (dupes), ` +
      `${totals.failed} article-level failures, ${totals.errored} source(s) errored, ` +
      `across ${activeSources.length} source(s).`
  );
}

// Only run automatically when executed directly (`node fetch-rss.js`),
// not when imported by tests.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}

module.exports = {
  cleanHtml,
  truncate,
  cleanTitle,
  normalizeUrl,
  parseArticleDate,
  isWithinAgeLimit,
  extractImage,
  idFromUrl,
  isTransientError,
  mapWithConcurrency,
};
