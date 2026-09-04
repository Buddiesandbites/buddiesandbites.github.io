# Buddies & Bites — upgraded Ledger + HungerBay alerts

This build combines the Ledger, HungerBay sync, cancellation rules, HungerBay
accept/reject controls, and background Web Push alerts.

## What is upgraded

### HungerBay
- HungerBay `pending` and `acknowledged` orders appear in **🔔 New Orders**.
- HungerBay orders show **Accept order**, **Reject**, and **Cancel order** actions.
- Accept/Reject/Cancel attempts are sent to HungerBay through the server's
  authenticated Playwright session.
- HungerBay `cancelled` orders are automatically moved out of New Orders,
  HungerBay, Active, Today, Overdue, and Delivered views.
- Cancelled orders appear in **Cancelled Orders** and **All** only.
- A cancelled order is terminal: it cannot be marked baked or delivered.
- Firestore persistence also enforces that a cancelled order cannot be
  resurrected by a stale second device.

### Alerts
- New order: full-screen foreground alert + repeating tone/vibration after the
  user enables Loud Alerts.
- Delivery time reached: full-screen foreground alert + tone.
- When the Ledger is backgrounded or completely closed, the service worker
  receives a Web Push notification.
- Push notifications use the standard browser/Android notification sound and
  vibration. The web platform cannot guarantee a custom alarm sound or Android
  full-screen intent while the browser is closed.

## Server setup

1. Copy `.env.example` to `.env`.
2. Put your Firebase Admin service-account JSON in the server environment (or
   set `FIREBASE_SERVICE_ACCOUNT_FILE`).
3. Install packages:

   `npm install`

4. Generate Web Push VAPID keys once:

   `npm run generate-vapid`

   Keep the generated keys stable in your server environment. Never upload
   `vapid-keys.json` to GitHub.
5. Run HungerBay login once:

   `npm run login`

   This creates `hungerbay-storage.json`. Never upload that file to GitHub.
6. Start the server:

   `npm start`

7. Deploy the server on an HTTPS host that stays running. The GitHub Pages
   Ledger is already configured to derive the push server URL from the
   HungerBay sync URL:
   `https://buddiesandbites-github-io.onrender.com/sync/hungerbay`

   If you deploy the server somewhere else, edit `HUNGERBAY_SYNC_API` in
   `buddies-and-bites-ledger.html` or set `window.BNB_HUNGERBAY_SYNC_API`
   before the Ledger script runs.
8. Open the Ledger on each phone, log in, tap the bell, and allow notifications.
   The first tap also unlocks the foreground tone and registers that device for
   background push.

## Important hosting note

Web Push itself is free. The browser does not need to stay open. However, the
server that watches Firestore and HungerBay must be running for closed-app
alerts to be generated. If a free hosting plan sleeps the server, push timing
can be delayed until the server wakes.

## Security

Do not commit:
- `.env`
- `hungerbay-storage.json`
- Firebase Admin service-account JSON
- `vapid-keys.json`

The public Ledger contains only the Firebase Web configuration already used by
Firestore and no HungerBay credentials or server secrets.


## Render: fixing "Sync unavailable" / expired HungerBay session

If the Ledger says **Sync unavailable** and Render logs say:

`HungerBay session expired. Refresh the Render Secret File hungerbay-storage.json...`

the Render server is healthy but its saved HungerBay browser session has expired.

### Refresh the session without Render Shell

Render Free does not provide Shell access, so do the login on a computer where you can run Node/Playwright:

1. Download/clone this project.
2. In the project folder run:
   `npm install`
3. Set `HUNGERBAY_LOGIN_URL` and `HUNGERBAY_DASHBOARD_URL` in a local `.env`.
4. Run:
   `npm run login`
5. A browser window opens. Log into the HungerBay Merchant dashboard.
6. Return to the terminal and press Enter.
7. The script creates `hungerbay-storage.json`.
8. In Render open **Environment → Secret Files → Edit**.
9. Keep the secret filename exactly:
   `hungerbay-storage.json`
10. Replace its contents with the newly generated `hungerbay-storage.json` file.
11. Save/deploy Render.
12. Check:
   `/health`
   and then:
   `/hungerbay/session-check`
13. Return to the Ledger and press **Sync orders now**.

The server now automatically detects the Render Secret File at:

`/etc/secrets/hungerbay-storage.json`

so you do not need Render Shell or a manual `HUNGERBAY_STORAGE_STATE` path.

### Important

The HungerBay session is a credential-like browser session. Never commit `hungerbay-storage.json` to GitHub and never paste its contents into the public Ledger.

If HungerBay expires the session again, repeat the local `npm run login` process and replace the Render Secret File again.

## Render build/start commands

**Build Command**

`npm install && npx playwright install chromium`

**Start Command**

`npm start`

No `npm install` is needed manually inside Render Shell. Render runs the Build Command during deployment.
