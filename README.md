# RSS Ingest (free, automatic, self-updating)

This little project fetches RSS feeds on a schedule and writes new articles
into Firestore. Once set up, it runs forever for free via GitHub Actions —
no server, no AI model, no manual re-pasting of feed content ever needed
again.

## Setup (one time)

1. **Create a Firebase project** at https://console.firebase.google.com
   and enable Firestore (production mode).

2. **Generate a service account key**
   Firebase Console → Project Settings → Service Accounts → *Generate new
   private key*. This downloads a JSON file. **Do not commit this file.**

3. **Create a new GitHub repo** and push these files into it:
   - `package.json`
   - `fetch-rss.js`
   - `.github/workflows/fetch-rss.yml`
   - this `README.md`

4. **Add your Firebase key as a GitHub Secret**
   In your repo: Settings → Secrets and variables → Actions →
   *New repository secret*.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: paste the **entire contents** of the service account JSON file.

5. **Edit the source list**
   Open `fetch-rss.js` and edit the `SOURCES` array near the top — add every
   RSS feed URL you want to pull from, each with a short `id`, a display
   `name`, and a `category`.

6. **Test it manually**
   Push your code, go to the **Actions** tab in GitHub, select
   "Fetch RSS Feeds," and click **Run workflow**. Check the logs — you
   should see something like:
   ```
   Fetching: RONB Post (https://www.ronbpost.com/feed/)
     ✓ RONB Post: 8 new, 0 already existed
   Done. 8 new article(s) added across 1 source(s).
   ```
   Then check your Firestore console — an `articles` collection should now
   have documents in it.

7. **That's it.** From now on, GitHub runs this automatically every 20
   minutes, forever, for free — no further action needed. Your app's
   Home feed just reads from the `articles` collection in Firestore as
   already planned in the PRD.

## Why this works and copy-pasting didn't

RSS is a **live endpoint** — every time this script requests the feed URL,
the publisher's server returns whatever is current *at that moment*.
Copy-pasting feed content into a chat only captures a single snapshot in
time; nothing built from that snapshot can ever see new articles, because
there's no ongoing connection back to the source. This script *is* that
ongoing connection.

## Local testing (optional)

If you want to test on your own machine before relying on GitHub Actions:

```bash
npm install
export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/serviceAccountKey.json)"
node fetch-rss.js
```

## Free-tier limits to be aware of

- **GitHub Actions:** 2,000 free minutes/month on private repos, unlimited
  on public repos. A 20-minute-interval job that finishes in a few seconds
  uses a tiny fraction of this.
- **Firestore (Spark plan):** 50,000 reads / 20,000 writes / 20,000 deletes
  per day, 1GB storage — comfortably enough for a personal-scale news app.
  Note this script does one Firestore *read* per feed item (to check for
  duplicates) plus one *write* per new item, so keep an eye on total item
  count across all your sources if you add many feeds.
