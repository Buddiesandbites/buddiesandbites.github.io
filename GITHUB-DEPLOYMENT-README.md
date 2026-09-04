# Buddies & Bites — GitHub-ready package

This package has been cleaned for uploading to GitHub.

## Removed from the upload package
- `node_modules/` (install with `npm install`)
- Firebase service-account private key
- Firestore backup data
- D1 SQL/database export chunks
- Large Firebase/debug output files

## GitHub Pages
`index.html` is at the repository root, so the static website can be published with GitHub Pages.

## Backend
The HungerBay sync server (`hungerbay-sync-server.js`) and related Node scripts are included as source code, but they are not run by GitHub Pages. Deploy the backend separately and provide its secrets through environment variables/secret files.

## Before deploying
1. Keep real `.env`, service-account JSON, HungerBay storage state, and VAPID private keys out of Git.
2. Run `npm install` where the Node backend is deployed.
3. Configure the backend secrets in the hosting provider.
4. Because the original package contained a Firebase service-account private key, rotate/revoke that key in Google Cloud/Firebase before using the cleaned repository publicly.
