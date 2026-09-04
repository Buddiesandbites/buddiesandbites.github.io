# Buddies & Bites

Buddies & Bites website, admin/ledger pages, Cloudflare D1 API worker, and HungerBay sync backend.

## Repository structure

- `index.html` — public website entry point
- `buddies-and-bites-*.html` — shop, login, admin, ledger and management pages
- `d1-worker/` — Cloudflare Worker + D1 API
- `hungerbay-sync-server.js` — HungerBay sync + Web Push backend
- `hungerbay-login.js` — local HungerBay session helper
- `sw-admin.js` — admin service worker
- `package.json` — backend dependencies and scripts

## What is intentionally NOT in this repository

The GitHub-ready package excludes:

- `node_modules/`
- Firebase service-account private keys
- Firestore backup exports
- D1/customer/order SQL exports
- generated D1 migration chunks
- local HungerBay session/storage files
- VAPID private-key files

These files can contain credentials or customer/order data and should stay outside a public GitHub repository.

## Local backend setup

1. Install Node.js.
2. Run:

```bash
npm install
```

3. Copy `.env.example` to `.env` and fill in the required private values.
4. Keep `hungerbay-storage.json` and VAPID private keys outside Git.
5. Start the sync server:

```bash
npm start
```

## Cloudflare D1 worker

The worker configuration is in `d1-worker/wrangler.toml`.

Deploy from the `d1-worker` directory with Wrangler after authenticating to Cloudflare:

```bash
npx wrangler deploy
```

The production D1 API URL is configured through environment variables in the backend. Do not commit API bearer tokens.

## GitHub Pages

The public site can be served from the repository root because `index.html` is at the root.

For GitHub Pages:

1. Push this cleaned package to the repository.
2. Open **Settings → Pages**.
3. Select **Deploy from a branch**.
4. Select the desired branch and `/ (root)`.
5. Save.

The Node/Playwright HungerBay backend is **not** run by GitHub Pages. Deploy that backend separately and configure its secrets there.

## Security note

The original project contained a Firebase service-account private key. If that key was ever exposed or committed to a public repository, revoke/delete it in Google Cloud/Firebase and create a new credential before continuing.

Never commit:
- `.env`
- Firebase service-account JSON
- HungerBay session/storage state
- VAPID private keys
- database exports containing customer/order data

See `.gitignore` for the repository-level protections.

### Order Ledger live-refresh update
- The Ledger performs its initial order load once and then checks for D1 changes every 5 seconds.
- After the initial load, only orders whose `updated_at` changed are fetched from the Worker.
- The initial order snapshot supports up to 500 orders instead of silently stopping at 100.
- No database migration, import, delete, reset, or existing-order modification is performed by this frontend/Worker code change.

