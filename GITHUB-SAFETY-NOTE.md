# Buddies & Bites — GitHub-safe D1 project

This package is prepared for source-code hosting. It intentionally excludes production/private data.

## Intentionally excluded
- Firebase service-account private key
- Firestore backup/export JSON
- D1 SQL exports and chunk-import files
- Existing D1 snapshots containing customer/order/product data
- HungerBay authenticated session/storage files
- VAPID private-key files
- node_modules and Wrangler local state
- Local database/runtime files

## Important
The live Cloudflare D1 database is NOT contained in this ZIP. The website/Worker connects to the configured D1 API.

The Firebase service-account key that existed in the original project should be revoked/rotated if it was ever exposed outside your private machine.

## Local backend secrets
Use environment variables or your hosting provider's secret store. Never commit `.env`, HungerBay storage state, service-account JSON, or VAPID private keys.

## D1 Worker
Deploy from `d1-worker` with Wrangler. The D1 database itself remains in Cloudflare; it is not uploaded to GitHub.
