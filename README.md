# RSS Ingest v2 (hardened)

This is an upgraded version of the ingestion script with the reliability,
data-quality, and performance issues fixed. If you're setting this up for
the first time, follow the numbered setup steps below. If you're
**upgrading an existing repo**, read the "Upgrading from v1" section first
— there's one important thing to know about duplicate articles.

## What changed from v1

| Area | v1 | v2 |
|---|---|---|
| Article failures | One bad item could stop the whole feed | Each article is isolated in its own try/catch — one failure never affects the rest |
| Duplicate detection | Firestore read, then write (race condition if two runs overlap) | Atomic `create()` — Firestore itself rejects the second write, no read needed |
| Dates | Passed straight into `new Date()`, could crash on bad data | Validated with safe fallback; unparseable dates don't block ingestion |
| Images | Checked a couple of RSS fields, one HTML pattern | Checks `enclosure`, `media:content`, `media:thumbnail`, `item.image`, lazy-loaded (`data-src`), and more |
| URLs | Stored as-is | Normalized: tracking params (`utm_*`, `fbclid`, `gclid`) and fragments stripped, so the same article isn't duplicated by URL variants |
| Titles | `item.title \|\| "(untitled)"` | HTML-stripped, whitespace-validated, length-capped |
| Snippets | Whitespace-normalized only | HTML tags actually stripped before truncation |
| Feed fetching | Sequential, one at a time | Parallel (configurable concurrency), so one slow feed doesn't delay the others |
| Network errors | Immediate failure | Retried 2–3x with exponential backoff for timeouts, 502/503, DNS blips |
| Firestore errors | Immediate failure | Transient errors (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, etc.) retried |
| Item volume | No cap | Max 50 items per source per run (configurable per-source) |
| Backlog | A new/changed feed could import years of old articles | Articles older than 48h (configurable) are skipped |
| Source health | `active: true` regardless of actual health | `enabled` (config) and `lastFetchStatus`/`lastRunCounts` (live health) are now separate fields |
| Workflow overlap | None — a slow run could overlap the next | `concurrency` group added to the GitHub Actions workflow |
| Dependency installs | `npm install` (non-reproducible) | `npm ci` from a committed `package-lock.json` |
| ID hashing | SHA-1 | SHA-256 (see migration note below) |
| Tests | None | 26 unit tests covering URL/date/title/image handling and edge cases |
| Schedule | Every 20 minutes | Every 5 minutes, with overlap protection so this is safe |

## ⚠️ Upgrading from v1 — read this first

This version hashes article IDs with **SHA-256** instead of SHA-1. That
means every article already sitting in your `articles` collection will get
a **different** document ID under the new code, so on your first run after
upgrading, all previously-ingested articles will be re-added as if they
were new (a one-time batch of "duplicates" showing the same headlines
twice in your Firestore data, though your app can dedupe display by
`originalUrl` if that's a concern).

If you'd rather avoid this entirely, you have two options:
1. **Do nothing** — accept the one-time duplication. It's harmless data
   bloat, well within free-tier limits, and never happens again after the
   first run.
2. **Wipe the `articles` collection** in the Firebase Console before your
   first v2 run, so everything re-ingests cleanly under the new IDs with
   no duplicates at all.

## Setup (same as before)

1. Create a Firebase project + enable Firestore.
2. Generate a service account key (Project Settings → Service Accounts).
3. Push all files in this folder — including `package-lock.json` — to your
   GitHub repo, preserving the folder structure exactly:
   - `package.json`
   - `package-lock.json`
   - `fetch-rss.js`
   - `.github/workflows/fetch-rss.yml`
   - `tests/util.test.js`
   - this `README.md`
4. Add your key as a GitHub secret named `FIREBASE_SERVICE_ACCOUNT`.
5. Edit the `SOURCES` array in `fetch-rss.js` to add/remove feeds.
6. Trigger the workflow manually once from the Actions tab to confirm it
   works, then let the 5-minute schedule take over automatically.

## Running tests

```bash
npm ci
npm test
```

This runs 26 tests against the pure logic functions (URL normalization,
date parsing, title/HTML cleaning, image extraction, transient-error
detection) — no live network or Firebase credentials needed.

## About the image problem specifically

There are two different reasons images can be missing, and they need different fixes:

**1. The RSS feed itself has no image field.** A lot of news sites' feeds
only publish title + a short excerpt, with no `enclosure`, `media:content`,
or embedded `<img>` — there's nothing in the feed for any extraction logic
to find, no matter how thorough it is. This turned out to be the actual
cause for your sources: their `imageUrl` was showing as `null` in Firestore
even after the extraction fix, meaning the RSS data genuinely had nothing.

The fix: when `extractImage()` finds nothing in the RSS item, the script
now **fetches the article page itself and reads its `og:image` meta tag**
— the thumbnail every modern news site already generates for link previews
(Facebook, Twitter, WhatsApp, etc.). This is a small, targeted fetch of
just the page head, not scraping the article body, so it stays consistent
with the aggregator/attribution model rather than crossing into
full-content scraping. It's best-effort: if a page fetch fails or has no
og:image either, `imageUrl` stays `null` and your frontend should just
show a fallback placeholder image in that case.

**2. The RSS/page had an image, but your frontend won't render it.** If
you're using Next.js's `<Image>` component, it blocks external image
domains by default unless you explicitly allow them in `next.config.js`
via `images.remotePatterns`. Some publishers also block "hotlinked"
images unless a proper referrer policy is sent — add
`referrerPolicy="no-referrer"` to your `<img>` tags as a safety net.
Check your browser DevTools Console for red errors mentioning "image" or
a domain name to tell these apart quickly.

## Free-tier impact of the faster schedule

Firestore reads dropped essentially to zero for duplicate checks (the old
one-read-per-item pattern is gone — `create()` needs no preceding read),
so switching from 20-minute to 5-minute runs is **not** a meaningful
Firestore cost increase. GitHub Actions minutes usage is still trivial:
even at ~288 runs/day, each finishing in well under a minute, you're
nowhere near the 2,000 free minutes/month limit (unlimited on public
repos anyway).

## Next architectural step (not done yet, flagged for later)

Sources currently still live as a hardcoded array in `fetch-rss.js`. The
natural next step — once you're building the admin panel — is moving
`SOURCES` into a Firestore collection (e.g. `sourceConfigs`) that the
script reads at the start of each run, so the admin panel can add, edit,
enable/disable, or remove sources without touching code or redeploying.
The `enabled` field structure in this version is already set up to make
that migration straightforward when you're ready.
