# Security

Do not commit credentials, session state, private keys, or customer/order database exports.

If a credential has been exposed:
1. Revoke/rotate it immediately at the issuing provider.
2. Replace the credential in the deployment environment.
3. Check Git history if it was previously committed.

For this project, treat the following as secret:
- Firebase service-account JSON
- HungerBay session/storage state
- VAPID private key
- D1 API bearer token
- Staff API key (`STAFF_API_KEY` on the D1 Worker and sync server) — this gates staff-only reads/writes; the browser login asks staff to enter it and stores it only in localStorage
- Gemini API keys (`GEMINI_API_KEY`, `GEMINI_SHOP_API_KEY` — Worker secrets only; never sent to or stored in the browser)
- `.env` files

## Staff roles (D1)

The deployed Worker supports two separate staff secrets:

- `STAFF_API_KEY` — Master Admin. Allows staff reads and writes.
- `STAFF_READONLY_API_KEY` — View-only staff. Allows staff reads but rejects writes with HTTP 403.

The browser never contains either secret. Staff enter the appropriate key at login, and the login screen verifies it against `POST /api/auth/verify` before creating a session.

Configure the secrets with Wrangler:

```bash
npx wrangler secret put STAFF_API_KEY
npx wrangler secret put STAFF_READONLY_API_KEY
```

If the view-only account is not needed, `STAFF_READONLY_API_KEY` may be left unset; the Aman/View-only login will then correctly fail instead of granting access.
