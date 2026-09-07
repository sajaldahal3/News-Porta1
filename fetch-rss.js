/**
 * fetch-rss.js
 *
 * Fetches a list of RSS feeds and writes any NEW articles into Firestore.
 * Safe to run on repeat (e.g. every 20 minutes via GitHub Actions) —
 * it dedupes using the article link as the Firestore document ID, so
 * re-running never creates duplicates and always picks up fresh items.
 *
 * Run locally with:  node fetch-rss.js
 */

const admin = require("firebase-admin");
const Parser = require("rss-parser");

// ---------------------------------------------------------------------
// 1. CONFIG — add / edit your sources here.
//    "id" should be a short, stable slug for the source (used in the DB).
// ---------------------------------------------------------------------
const SOURCES = [
  {
    id: "ronbpost",
    name: "RONB Post",
    category: "Nepal",
    rssUrl: "https://www.ronbpost.com/feed/",
  },
  // Add more sources below, e.g.:
  // { id: "bbc-world", name: "BBC World", category: "World", rssUrl: "https://feeds.bbci.co.uk/news/world/rss.xml" },
];

const SNIPPET_MAX_LENGTH = 250; // hard cap per your copyright/crediting rules

// ---------------------------------------------------------------------
// 2. FIREBASE INIT
//    Reads the service account JSON from an environment variable
//    (set as a GitHub Secret in the workflow — see fetch-rss.yml).
// ---------------------------------------------------------------------
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT environment variable. " +
        "Set it to the full contents of your Firebase service account JSON."
    );
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return admin.firestore();
}

// ---------------------------------------------------------------------
// 3. HELPERS
// ---------------------------------------------------------------------

// Firestore document IDs can't contain slashes, so we hash the URL
// into a safe, stable, deterministic ID.
function idFromUrl(url) {
  const crypto = require("crypto");
  return crypto.createHash("sha1").update(url).digest("hex");
}

function truncate(text, max) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trim() + "…" : clean;
}

// Try to find an image from common RSS fields (enclosure, media:content, etc.)
function extractImage(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item["media:content"] && item["media:content"]["$"] && item["media:content"]["$"].url) {
    return item["media:content"]["$"].url;
  }
  // Fallback: look for the first <img> in the content/description HTML
  const html = item["content:encoded"] || item.content || item.contentSnippet || "";
  const match = html.match(/<img[^>]+src="([^">]+)"/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------
// 4. MAIN INGESTION LOGIC
// ---------------------------------------------------------------------
async function ingestSource(db, parser, source) {
  console.log(`Fetching: ${source.name} (${source.rssUrl})`);

  let feed;
  try {
    feed = await parser.parseURL(source.rssUrl);
  } catch (err) {
    console.error(`  ✗ Failed to fetch/parse feed for ${source.name}:`, err.message);
    await db.collection("sources").doc(source.id).set(
      {
        name: source.name,
        category: source.category,
        rssUrl: source.rssUrl,
        active: true,
        lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastFetchStatus: "error",
        lastFetchError: err.message,
      },
      { merge: true }
    );
    return { added: 0, skipped: 0 };
  }

  let added = 0;
  let skipped = 0;

  for (const item of feed.items) {
    const originalUrl = item.link;
    if (!originalUrl) continue;

    const docId = idFromUrl(originalUrl);
    const docRef = db.collection("articles").doc(docId);

    const existing = await docRef.get();
    if (existing.exists) {
      skipped++;
      continue; // already ingested — skip re-writing
    }

    const publishedAt = item.isoDate
      ? admin.firestore.Timestamp.fromDate(new Date(item.isoDate))
      : admin.firestore.FieldValue.serverTimestamp();

    await docRef.set({
      sourceId: source.id,
      sourceName: source.name,
      category: source.category,
      title: item.title || "(untitled)",
      snippet: truncate(item.contentSnippet || item.summary || item.content, SNIPPET_MAX_LENGTH),
      imageUrl: extractImage(item),
      originalUrl,
      publishedAt,
      ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
      likeCount: 0,
      saveCount: 0,
      hidden: false,
    });

    added++;
  }

  // Update the source's health status so your admin panel can show it
  await db.collection("sources").doc(source.id).set(
    {
      name: source.name,
      category: source.category,
      rssUrl: source.rssUrl,
      active: true,
      lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastFetchStatus: "ok",
    },
    { merge: true }
  );

  console.log(`  ✓ ${source.name}: ${added} new, ${skipped} already existed`);
  return { added, skipped };
}

async function main() {
  const db = initFirebase();
  const parser = new Parser({
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsPortalBot/1.0)" },
  });

  let totalAdded = 0;
  for (const source of SOURCES) {
    const result = await ingestSource(db, parser, source);
    totalAdded += result.added;
  }

  console.log(`\nDone. ${totalAdded} new article(s) added across ${SOURCES.length} source(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
