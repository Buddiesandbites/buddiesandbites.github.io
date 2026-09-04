# Buddies & Bites — D1 Migration Status

This build switches the browser pages and HungerBay sync server from Firebase/Firestore to the deployed Cloudflare D1 API.

## Already completed in Cloudflare

- D1 database: `buddiesandbites`
- D1 Worker: `buddiesandbites-d1-api`
- Worker URL: `https://buddiesandbites-d1-api.buddiesandbites.workers.dev`
- Firestore data imported into D1
- Migration `0001_add_updated_at.sql` applied
- Migration `0002_hungerbay_sync.sql` applied

## Code changes in this build

- Browser pages use `d1-firestore-compat.js`, a Firestore-compatible client facade backed by the D1 Worker API.
- Firebase web SDK CDN scripts and the exposed Firebase web API key were removed.
- The Firebase Admin service-account file is excluded from the deployable ZIP.
- `hungerbay-sync-server.js` now writes/reads through the D1 Worker API.
- Push subscription/event/order-state collections are available through the Worker API.
- D1 document writes maintain `updated_at`.
- `package.json` no longer depends on `firebase-admin` for the live sync server — `firebase-admin` is only listed because `backup-firestore.js` (a standalone, occasional-use tool for pulling a read-only snapshot of the old Firebase project) still needs it. `hungerbay-sync-server.js` itself never imports it.

## Required external deployment actions

1. Deploy the updated `d1-worker` with Wrangler:
   `npx wrangler deploy`
2. Confirm the Worker health endpoint returns `ok: true`.
3. Upload the project files to the GitHub repository.
4. On the HungerBay sync host, set:
   `D1_API_URL=https://buddiesandbites-d1-api.buddiesandbites.workers.dev`
5. Keep the HungerBay Playwright session secret configured on the sync host.
6. Restart/redeploy the HungerBay sync service.

## Update (this build): staff-key auth is now real, not optional

Earlier builds documented a `STAFF_API_KEY` access model, but the Worker
never actually checked it — every collection was fully open to anyone who
found the Worker URL (which is public, hardcoded in `d1-firestore-compat.js`).
This build fixes that:

- `d1-worker/src/index.js` now enforces `STAFF_API_KEY` (as an
  `Authorization: Bearer <key>` or `X-Api-Key` header) for everything the
  access model in `README-D1-MIGRATION.md` describes as staff-only —
  listing all orders/customers, editing or deleting anything, editing
  shop config/ads banner, and the push-notification collections. It
  **fails closed**: if the secret isn't set on the Worker, those routes
  return 401 rather than silently allowing everything through.
- The Worker's `/api-batch` endpoint (used by `hungerbay-sync-server.js`
  for atomic bulk order upserts) is implemented now — it didn't exist in
  the deployed Worker before, so HungerBay's `batch().commit()` calls were
  silently hitting a 404.
- `buddies-and-bites-login.html` stores the same key in `localStorage`
  after a successful login; `d1-firestore-compat.js` reads it and attaches
  it to every request automatically.
- `hungerbay-sync-server.js`'s own HTTP endpoints (`/sync/hungerbay`,
  `/hungerbay/order-status`, `/push/register`, `/push/unregister`,
  `/push/status`, `/hungerbay/session-check`) also now require the same
  key via `STAFF_API_KEY` in that server's environment — previously these
  were unauthenticated too, and `/hungerbay/order-status` can actually
  change order status on the live HungerBay merchant dashboard.

**Required action:** set `STAFF_API_KEY` as a Worker secret (below), put the
the same value in `STAFF_API_KEY` in the sync server's `.env`. The browser
admin pages now ask staff to enter the Worker key at login instead of storing
it in source code. Redeploy the Worker and sync server after setting their
secrets; the static site itself contains no staff key.

`SYNC_API_TOKEN` remains the separate, optional token this project already
used for the sync server's own outbound calls to the Worker (see
`d1Request()` in `hungerbay-sync-server.js`); set it to the same value as
`STAFF_API_KEY` since the Worker checks either header name.
