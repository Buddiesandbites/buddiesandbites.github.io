# Moving off Firebase Firestore → Cloudflare D1

This repo's pages (`index.html`, `buddies-and-bites-shop.html`, `-admin`,
`-ads-manager`, `-ledger`, `-manage-products`) used to talk directly to
Firebase Firestore from the browser. They now talk to a small Cloudflare
Worker (`d1-worker/`) backed by a D1 database, through
`assets/d1-client.js` — a shim that mimics the handful of Firestore
methods this project uses, so the page logic itself didn't need rewriting.

## ⚠️ Do this first, regardless of anything else

Your original project export contained a **live Firebase service-account
private key** (`firebase-backup-key.json`) and a raw Firestore backup with
real customer phone numbers. Neither is in this repo, but:

1. **Rotate/delete that service-account key in the Firebase console now.**
   It already left your machine once (in the file you shared), so treat it
   as compromised no matter what.
2. Never commit `firebase-backup-key.json`, `.env`, `hungerbay-storage.json`,
   `vapid-keys.json`, or any `firestore-backup-*/` / `d1-*-import/` folder —
   they're in `.gitignore` here, but double-check before every push.
3. The raw migrated data (SQL batches + Firestore JSON backup) is **not**
   in this repo — see "Your data" below for where it went instead.

## One-time setup

1. **Install Wrangler** (Cloudflare's CLI) and log in:
   ```
   npm install -g wrangler
   wrangler login
   ```

2. **Create/point at your D1 database** (skip if `buddiesandbites` already
   exists — `d1-worker/wrangler.toml` already has its `database_id`):
   ```
   cd d1-worker
   wrangler d1 execute buddiesandbites --remote --file=migrations/0000_init_schema.sql
   wrangler d1 execute buddiesandbites --remote --file=migrations/0001_add_updated_at.sql
   wrangler d1 execute buddiesandbites --remote --file=migrations/0002_hungerbay_sync.sql
   ```

3. **Import your migrated data** (from the separate `migration-data`
   archive you were given, not from this repo):
   ```
   wrangler d1 execute buddiesandbites --remote --file=../migration-data/d1-import-ready/batch-01.sql
   ... (repeat for every batch-*.sql, or write a small loop)
   wrangler d1 execute buddiesandbites --remote --file=../migration-data/d1-remaining-import/document-0001.sql
   ... (repeat for every document-*.sql)
   ```
   `d1-import-ready/` looks like the final, complete export; the older
   `d1-import/` and `d1-chunk-import/` folders (also outside this repo)
   look like earlier/duplicate generation attempts of the same data —
   spot-check row counts before relying on them for anything.

4. **Set the staff API key as a Worker secret** (pick a long random
   string — this is what protects writes/reads of orders, customer
   listings, etc.):
   ```
   wrangler secret put STAFF_API_KEY
   ```
   Do **not** put this secret in the repository. The admin login page now asks
   staff to enter the Worker `STAFF_API_KEY` at sign-in and stores it only in
   browser `localStorage` for the active device.

4b. **(Optional) Set the Gemini AI keys as Worker secrets**, if you want
   the "AI suggestion" button on the products page and the customer chat
   widget on the shop page to work. Neither the browser nor D1 ever sees
   these — the Worker calls Gemini on the site's behalf:
   ```
   wrangler secret put GEMINI_API_KEY
   wrangler secret put GEMINI_SHOP_API_KEY
   ```
   `GEMINI_API_KEY` powers the staff-only product-suggestion tool
   (`/api/ai/product-suggest`, requires the staff key). `GEMINI_SHOP_API_KEY`
   powers the public customer chat widget (`/api/ai/shop-chat`, no login —
   get a free key at aistudio.google.com and use a **separate** key from
   the staff one, so a public-side issue never affects admin tooling). If
   you skip this step, the AI suggestion button shows an error and the chat
   widget falls back to its "call or WhatsApp us" message — nothing else
   on the site is affected either way.

5. **Deploy the Worker:**
   ```
   wrangler deploy
   ```
   Copy the `*.workers.dev` URL it prints.

6. **Point the site at your Worker.** Edit `assets/d1-config.js` and set
   `window.BNB_D1_API_BASE` to that URL.

7. Commit and push this repo to GitHub Pages as usual.

## How the access model works

The old setup had Firestore rules (not included in your export) plus a
client-side-only password gate on the admin pages. The Worker now enforces:

- **Public, no key needed:** reading products/reviews/menu config; a
  customer creating a brand-new order or review, or updating their own
  customer record when they order (needed for the repeat-customer/review
  discount feature); visit counters.
- **Requires the staff key** (set automatically in `localStorage` after
  logging in via `buddies-and-bites-login.html`): listing/editing/deleting
  orders, listing customers in bulk, editing products, deleting anything,
  editing shop config/ads banner.

This is a real improvement because the Worker actually verifies the secret.
The current setup still uses one shared staff API key rather than separate
server-side accounts. Usernames (`Buddies&bites` and `Aman`) are role labels
on the client and are not a substitute for independent authentication. For
stronger per-person access control, use Cloudflare Access or separate tokens.

One document, `meta/geminiConfig`, is blocked entirely by the Worker: your
old shop page read a Gemini API key out of it client-side, which meant
that key was exposed to every visitor. If you want the AI chat widget
back, put that key in a Worker secret and add a small proxy endpoint
instead of exposing it to the browser again.

## Known limitations of the shim (`assets/d1-client.js`)

- `onSnapshot()` polls the API every ~4 seconds rather than pushing
  updates instantly — other tabs/devices see changes with a short delay.
- `runTransaction()` is best-effort, not atomic (read → your code runs →
  writes applied). Fine for a single small bakery's traffic; would need a
  dedicated batched Worker endpoint if concurrent order volume grows a lot.

## HungerBay sync server (`hungerbay-sync-server.js`)

This has also been ported off Firestore — it now talks to your D1 Worker
through `d1-db.js`, a small Node client mimicking the same handful of
Firestore methods it used before (`collection().doc().get/set/delete`,
`where('enabled','==',true)`, and a real atomic `batch()` for bulk order
upserts via the Worker's new `/api-batch` endpoint).

To run it:
1. Add to its `.env` (see `.env.example`):
   ```
   D1_API_BASE=https://buddiesandbites-d1-api.YOURSUBDOMAIN.workers.dev
   STAFF_API_KEY=<same value you set with `wrangler secret put STAFF_API_KEY`>
   STAFF_READONLY_API_KEY=<optional separate view-only key>
   ```
2. `npm install` (this also refreshes `package-lock.json`, which still lists
   the now-unused `firebase-admin` from before this change), then `npm start`
   as before.

Everything else about it — the Playwright HungerBay scraping, the Web
Push logic, the Express routes — is unchanged, since only the
Firestore-specific calls needed swapping.

One behavioral note: `batch().commit()` here genuinely runs as one atomic
D1 transaction (unlike the browser-side shim's best-effort
`runTransaction()`), because this endpoint doesn't need a mid-flight read
step the way the browser code's stock/counter transactions do.

## Other legacy Node scripts

`hungerbay-login.js` (generates the Playwright session file — unrelated to
the database, no changes needed) and `backup-firestore.js` /
`import-firestore-to-d1.js` / `import-firestore-chunked.js` /
`import-remaining-firestore.js` (the one-time migration tools that produced
your `migration-data` archive) still reference Firestore directly. They
were one-time/reference tools, not part of the live site, so they weren't
ported — you shouldn't need to run them again once your data is in D1.

### Staff authentication

The D1 Worker uses two server-side secrets. `STAFF_API_KEY` is the Master Admin key and `STAFF_READONLY_API_KEY` is an optional separate View-only key. The login pages verify the entered key with `/api/auth/verify`; secrets are not committed to GitHub.
