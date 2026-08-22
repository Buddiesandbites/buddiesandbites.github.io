/*
 * Buddies & Bites — HungerBay -> Firestore sync worker
 *
 * This worker deliberately uses a real Playwright browser session instead of
 * putting HungerBay credentials or session/CSRF tokens into your website.
 * Run `npm run login` once to save an authenticated browser session.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');
const { chromium } = require('playwright');
const { URLSearchParams } = require('url');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_URL = process.env.HUNGERBAY_DASHBOARD_URL || 'https://hungerbay.com/merchant/dash-board';
const STORAGE_STATE = path.resolve(process.env.HUNGERBAY_STORAGE_STATE || './hungerbay-storage.json');
const POLL_MS = Number(process.env.HUNGERBAY_POLL_MS || 60000);
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const FIREBASE_SERVICE_ACCOUNT_FILE = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;

let db = null;
let configError = null;
try {
  let serviceAccount = null;
  if (FIREBASE_SERVICE_ACCOUNT_FILE && fs.existsSync(path.resolve(FIREBASE_SERVICE_ACCOUNT_FILE))) {
    serviceAccount = JSON.parse(fs.readFileSync(path.resolve(FIREBASE_SERVICE_ACCOUNT_FILE), 'utf8'));
  } else if (FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  }
  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
  } else {
    configError = 'Firebase service account is not configured yet';
  }
} catch (e) {
  configError = `Firebase configuration error: ${e.message}`;
}

function requireDb() {
  if (!db) throw new Error(configError || 'Firebase is not configured');
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoney(text) {
  const m = String(text || '').match(/₹\s*([0-9,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

function parseQty(text) {
  const m = String(text || '').match(/(?:^|\s)(\d+)\s*(?:piece|pieces|pc|pcs|pound|pounds|kg|gm|gram|grams|g)\b/i);
  return m ? Number(m[1]) : 1;
}

function normalizeStatus(raw) {
  const s = stripHtml(raw).toLowerCase();
  if (s.includes('food is ready')) return 'food is ready';
  if (s.includes('acknowledged')) return 'acknowledged';
  if (s.includes('accepted')) return 'accepted';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('refund')) return 'refunded';
  if (s.includes('decline')) return 'decline';
  if (s.includes('pending')) return 'pending';
  if (s.includes('paid')) return 'paid';
  if (s.includes('delayed')) return 'delayed';
  if (s.includes('failed')) return 'failed';
  if (s.includes('successful')) return 'successful';
  return s || 'unknown';
}

function mapRow(row) {
  const cells = Array.isArray(row) ? row : [];
  const orderId = stripHtml(cells[0]);
  const customerName = stripHtml(cells[1]);
  const itemsText = stripHtml(cells[2]);
  const deliveryDate = stripHtml(cells[3]);
  const deliveryTime = stripHtml(cells[4]);
  const transactionType = stripHtml(cells[5]);
  const paymentType = stripHtml(cells[6]);
  const hungerbayStatus = normalizeStatus(cells[7]);
  const liveAction = stripHtml(cells[8]);

  if (!orderId || !/^[A-Za-z0-9_-]+$/.test(orderId)) return null;

  return {
    id: `hungerbay_${orderId}`,
    source: 'hungerbay',
    hungerbayOrderId: orderId,
    orderNumber: orderId,
    customerName,
    customerPhone: '',
    customerAddress: '',
    flavour: itemsText,
    description: itemsText,
    quantity: parseQty(itemsText),
    price: parseMoney(itemsText),
    advancePaid: 0,
    orderDate: new Date().toISOString().slice(0, 10),
    deliveryDate,
    deliveryTime,
    deliveryDateTime: makeDateTime(deliveryDate, deliveryTime),
    transactionType,
    paymentType,
    hungerbayStatus,
    hungerbayLiveAction: liveAction,
    acceptanceStatus: ['pending', 'acknowledged'].includes(hungerbayStatus) ? 'new' : 'accepted',
    paymentStatus: ['paid', 'successful'].includes(hungerbayStatus) ? 'confirmed' : 'unknown',
    baked: hungerbayStatus === 'food is ready',
    delivered: false,
    hungerbayLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

function makeDateTime(dateText, timeText) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const s = String(dateText || '').toLowerCase();
  if (s && s !== 'today') {
    const parsed = new Date(dateText);
    if (!Number.isNaN(parsed.getTime())) { y = parsed.getFullYear(); m = parsed.getMonth(); d = parsed.getDate(); }
  }
  const tm = String(timeText || '').match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!tm) return new Date(y, m, d, 12, 0, 0).toISOString();
  let hh = Number(tm[1]);
  const mm = Number(tm[2]);
  const ap = (tm[3] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  return new Date(y, m, d, hh, mm, 0).toISOString();
}

function parseResponse(text) {
  const trimmed = String(text || '').trim();
  try {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.aaData)) return json.aaData;
    if (json.details && Array.isArray(json.details.aaData)) return json.details.aaData;
  } catch (_) {}
  return [];
}

async function getRecentOrders(page) {
  let captured = null;

  const handler = async response => {
    try {
      const url = response.url();

      if (!url.includes('/admin/ajax')) return;
      if (!url.includes('action=recentOrderInitial')) return;

      console.log('[sync] Found recentOrderInitial request');
      console.log('[sync] Method:', response.request().method());
      console.log('[sync] URL:', url);

      const text = await response.text();

      console.log('[sync] HungerBay order response:', text);

      if (text.includes('aaData')) {
        captured = text;
      }
    } catch (e) {
      console.log('[sync] Response error:', e.message);
    }
  };

  page.on('response', handler);

  console.log('[sync] Opening HungerBay dashboard...');

  await page.goto(DASHBOARD_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  page.off('response', handler);

  if (!captured) {
    throw new Error(
      'Could not capture HungerBay recentOrderInitial response'
    );
  }

  return parseResponse(captured);
}
  page.on('response', handler);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  page.off('response', handler);
  if (!captured) throw new Error('Could not capture HungerBay recentOrderInitial response');
  return parseResponse(captured);
}

async function ensureLoggedIn(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const url = page.url().toLowerCase();
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (url.includes('login') || body.includes('merchant login') || body.includes('sign in')) {
    throw new Error('HungerBay session expired. Run `npm run login` again.');
  }
}

async function syncOnce() {
  if (!fs.existsSync(STORAGE_STATE)) throw new Error(`Missing ${STORAGE_STATE}. Run npm run login first.`);
  requireDb();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    const rows = await getRecentOrders(page);
    const mapped = rows.map(mapRow).filter(Boolean);
    const batch = db.batch();
    for (const order of mapped) {
      const ref = db.collection('orders').doc(order.id);
      batch.set(ref, order, { merge: true });
    }
    if (mapped.length) await batch.commit();
    return { count: mapped.length, orderIds: mapped.map(o => o.hungerbayOrderId) };
  } finally {
    await browser.close();
  }
}

let lastRun = { at: null, result: null, error: null };
let running = false;

async function runSync() {
  if (running) return { skipped: true, reason: 'already running' };
  running = true;
  try {
    const result = await syncOnce();
    lastRun = { at: new Date().toISOString(), result, error: null };
    console.log('[sync]', lastRun);
    return result;
  } catch (error) {
    lastRun = { at: new Date().toISOString(), result: null, error: error.message };
    console.error('[sync]', error);
    throw error;
  } finally { running = false; }
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.SYNC_ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, running, lastRun, config: { dashboardConfigured: Boolean(DASHBOARD_URL), firebaseConfigured: Boolean(db), storageStatePresent: fs.existsSync(STORAGE_STATE) } }));
app.post('/sync/hungerbay', async (_req, res) => {
  try { res.json({ ok: true, ...(await runSync()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.listen(PORT, '0.0.0.0', () => console.log(`HungerBay sync server listening on port ${PORT}`));

if (require.main === module) {
  if (db && fs.existsSync(STORAGE_STATE)) {
    setTimeout(() => runSync().catch(() => {}), 2000);
    setInterval(() => runSync().catch(() => {}), POLL_MS);
  } else {
    console.log('[sync] Waiting for Firebase configuration and HungerBay storage state. /health is available.');
  }
}
