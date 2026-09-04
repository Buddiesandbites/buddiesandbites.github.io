/*
 * Buddies & Bites — HungerBay sync + Web Push worker
 *
 * - Uses a real Playwright session for HungerBay. Credentials/session tokens never
 *   go into the public Ledger.
 * - Syncs HungerBay orders into Cloudflare D1 through the D1 API.
 * - Exposes HungerBay accept/reject/cancel actions through a server-side browser.
 * - Sends free standards-based Web Push notifications for NEW and DUE events.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { chromium } = require('playwright');
const webpush = require('web-push');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_URL = process.env.HUNGERBAY_DASHBOARD_URL || 'https://hungerbay.com/merchant/dash-board';

// Render Secret Files are available at /etc/secrets/<filename>. Prefer that
// location automatically when the file exists, while keeping local development
// on ./hungerbay-storage.json. HUNGERBAY_STORAGE_STATE can still override it.
const DEFAULT_SECRET_STORAGE_STATE = '/etc/secrets/hungerbay-storage.json';
const DEFAULT_LOCAL_STORAGE_STATE = './hungerbay-storage.json';
const STORAGE_STATE = path.resolve(
  process.env.HUNGERBAY_STORAGE_STATE ||
  (fs.existsSync(DEFAULT_SECRET_STORAGE_STATE) ? DEFAULT_SECRET_STORAGE_STATE : DEFAULT_LOCAL_STORAGE_STATE)
);
const STORAGE_STATE_JSON = process.env.HUNGERBAY_STORAGE_STATE_JSON || '';
const POLL_MS = Number(process.env.HUNGERBAY_POLL_MS || 60000);
const PUSH_SCAN_MS = Number(process.env.PUSH_SCAN_MS || 10000);
const PUSH_LOOKBACK_MS = Number(process.env.PUSH_NEW_ORDER_LOOKBACK_MS || 15 * 60 * 1000);
const PUSH_DUE_GRACE_MS = Number(process.env.PUSH_DUE_GRACE_MS || 5 * 60 * 1000);
const D1_API_URL = String(process.env.D1_API_URL || 'https://buddiesandbites-d1-api.buddiesandbites.workers.dev').replace(/\/$/, '');
const D1_API_TOKEN = String(process.env.SYNC_API_TOKEN || '').trim();

// Same value as the D1 Worker's STAFF_API_KEY / the login page's D1_STAFF_KEY.
// Gates this server's own HTTP endpoints (sync trigger, HungerBay status
// changes, push registration) so they aren't callable by anyone who finds
// this URL — it's hardcoded in the public ledger page.
const LEDGER_STAFF_KEY = String(process.env.STAFF_API_KEY || '').trim();

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function requireStaffKey(req, res, next) {
  if (!LEDGER_STAFF_KEY) {
    console.warn('[auth] STAFF_API_KEY is not set — refusing this request. Set it in the environment to enable this endpoint.');
    return res.status(401).json({ ok: false, error: 'Staff API key not configured on the server' });
  }
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match ? match[1].trim() : '';
  if (!presented || !timingSafeEqual(presented, LEDGER_STAFF_KEY)) {
    return res.status(401).json({ ok: false, error: 'Staff API key required' });
  }
  next();
}

async function d1Request(pathname, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (D1_API_TOKEN) headers.Authorization = `Bearer ${D1_API_TOKEN}`;
  const response = await fetch(D1_API_URL + pathname, { ...options, headers });
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok || (body && body.ok === false)) {
    const err = new Error((body && body.error) || `D1 API request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return body;
}

class D1DocumentSnapshot {
  constructor(ref, document) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = !!document;
    this._document = document || null;
    this.createTime = document && document.created_at ? document.created_at : null;
  }
  data() { return this.exists ? this._document.data : undefined; }
}

class D1DocumentReference {
  constructor(collection, id) { this.collection = collection; this.id = String(id); }
  async get() {
    try {
      const body = await d1Request(`/api/${encodeURIComponent(this.collection.name)}/${encodeURIComponent(this.id)}`);
      return new D1DocumentSnapshot(this, body.document);
    } catch (e) {
      if (e.status === 404) return new D1DocumentSnapshot(this, null);
      throw e;
    }
  }
  async set(data, options = {}) {
    const payload = data || {};
    const path = `/api/${encodeURIComponent(this.collection.name)}/${encodeURIComponent(this.id)}`;
    if (options.merge) {
      try {
        await d1Request(path, { method: 'PATCH', body: JSON.stringify(payload) });
        return;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    } else {
      try {
        await d1Request(path, { method: 'PUT', body: JSON.stringify(payload) });
        return;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    await d1Request(`/api/${encodeURIComponent(this.collection.name)}`, {
      method: 'POST', body: JSON.stringify({ id: this.id, data: payload })
    });
  }
  async update(data) { return this.set(data, { merge: true }); }
  async delete() {
    try { await d1Request(`/api/${encodeURIComponent(this.collection.name)}/${encodeURIComponent(this.id)}`, { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
}

class D1QuerySnapshot {
  constructor(collection, documents) {
    this.docs = documents.map(d => new D1DocumentSnapshot(collection.doc(d.id), d));
    this.size = this.docs.length;
    this.empty = this.size === 0;
  }
  forEach(cb) { this.docs.forEach(cb); }
}

class D1Query {
  constructor(collection) { this.collection = collection; this._limit = 100; this._where = null; }
  limit(n) { this._limit = Math.min(Math.max(Number(n) || 100, 1), 500); return this; }
  orderBy() { return this; }
  where(field, op, value) { this._where = { field, op, value }; return this; }
  async get() {
    const body = await d1Request(`/api/${encodeURIComponent(this.collection.name)}?limit=${this._limit}`);
    let documents = body.documents || [];
    if (this._where && this._where.op === '==') {
      documents = documents.filter(d => d.data && d.data[this._where.field] === this._where.value);
    }
    return new D1QuerySnapshot(this.collection, documents);
  }
  doc(id) { return new D1DocumentReference(this.collection, id); }
}

class D1Collection extends D1Query {
  constructor(name) { super(null); this.name = name; this.collection = this; }
  doc(id) { return new D1DocumentReference(this, id); }
  async add(data) {
    const id = crypto.randomUUID();
    const ref = this.doc(id);
    await ref.set(data);
    return ref;
  }
}

class D1Batch {
  constructor() { this.ops = []; }
  set(ref, data, options) { this.ops.push(() => ref.set(data, options)); return this; }
  update(ref, data) { this.ops.push(() => ref.update(data)); return this; }
  delete(ref) { this.ops.push(() => ref.delete()); return this; }
  async commit() { for (const op of this.ops) await op(); }
}

const admin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => new Date().toISOString()
    }
  }
};

const db = {
  collection: name => new D1Collection(name),
  batch: () => new D1Batch(),
  async runTransaction(callback) {
    const writes = [];
    const tx = {
      async get(ref) { return ref.get(); },
      set(ref, data, options) { writes.push(ref.set(data, options)); },
      update(ref, data) { writes.push(ref.update(data)); },
      delete(ref) { writes.push(ref.delete()); }
    };
    const result = await callback(tx);
    await Promise.all(writes);
    return result;
  }
};

function requireDb() {
  if (!D1_API_URL) throw new Error('D1 API URL is not configured');
}

function getStorageStateSource() {
  // An environment variable is useful on hosts where Secret Files are not
  // available. It must contain the complete Playwright storageState JSON.
  if (STORAGE_STATE_JSON.trim()) {
    try {
      return JSON.parse(STORAGE_STATE_JSON);
    } catch (e) {
      throw new Error(`HUNGERBAY_STORAGE_STATE_JSON is invalid JSON: ${e.message}`);
    }
  }
  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error(
      `HungerBay session file is missing. Expected ${STORAGE_STATE}. ` +
      'Create a fresh session with "npm run login" locally and replace the Render Secret File.'
    );
  }
  try {
    return JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
  } catch (e) {
    throw new Error(`HungerBay session file is invalid JSON: ${e.message}`);
  }
}

function storageStatePresent() {
  return Boolean(STORAGE_STATE_JSON.trim()) || fs.existsSync(STORAGE_STATE);
}

function newHungerBayContext(browser) {
  return browser.newContext({ storageState: getStorageStateSource() });
}

let hungerBayAuthStatus = {
  state: storageStatePresent() ? 'session-file-present' : 'missing-session',
  checkedAt: null,
  error: null
};

function loadVapidKeys() {
  let keys = null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  } else if (fs.existsSync(VAPID_FILE)) {
    keys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  } else {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    try {
      fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
      console.log('[push] Generated VAPID keys at', VAPID_FILE);
      console.log('[push] For stable subscriptions across server restarts, set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env.');
    } catch (e) {
      console.warn('[push] Could not persist VAPID keys:', e.message);
    }
  }
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

const vapidKeys = loadVapidKeys();

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
  if (s.includes('cancelled') || s.includes('canceled') || /\bcancel\b/.test(s)) return 'cancelled';
  if (s.includes('rejected') || s.includes('declined') || /\bdecline\b/.test(s)) return 'decline';
  if (s.includes('refund')) return 'refunded';
  if (s.includes('pending')) return 'pending';
  if (s.includes('paid')) return 'paid';
  if (s.includes('delayed')) return 'delayed';
  if (s.includes('failed')) return 'failed';
  if (s.includes('successful')) return 'successful';
  return s || 'unknown';
}

function mapAcceptanceStatus(hungerbayStatus) {
  switch (hungerbayStatus) {
    case 'pending':
    case 'acknowledged':
      return 'new';
    case 'accepted':
    case 'food is ready':
      return 'accepted';
    case 'decline':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
      return 'refunded';
    default:
      return hungerbayStatus || 'unknown';
  }
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

  const cancelled = hungerbayStatus === 'cancelled';
  const rejected = hungerbayStatus === 'decline';
  const mapped = {
    id: `hungerbay_${orderId}`,
    source: 'hungerbay',
    orderSource: 'HungerBay',
    orderReference: 'Order by HungerBay',
    hungerbayOrderId: orderId,
    orderNumber: orderId,
    customerName,
    customerPhone: '',
    customerAddress: '',
    deliveryInstruction: '',
    subtotal: 0,
    deliveryFee: 0,
    tax: 0,
    total: 0,
    items: [],
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
    acceptanceStatus: mapAcceptanceStatus(hungerbayStatus),
    paymentStatus: (hungerbayStatus === 'paid' || hungerbayStatus === 'successful') ? 'confirmed' : (hungerbayStatus === 'refunded' ? 'refunded' : 'unknown'),
    hungerbayLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // Important: sync must never resurrect a cancelled order as baked/delivered.
  // For normal HungerBay orders, baked/delivered are deliberately omitted so
  // local Ledger actions are preserved between syncs.
  if (cancelled) {
    mapped.cancelled = true;
    mapped.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
    mapped.baked = false;
    mapped.bakedLocation = null;
    mapped.delivered = false;
  } else if (rejected) {
    mapped.cancelled = false;
  } else if (hungerbayStatus === 'food is ready') {
    mapped.baked = true;
  }

  return mapped;
}

function makeDateTime(dateText, timeText) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const s = String(dateText || '').toLowerCase();
  if (s && s !== 'today') {
    const parsed = new Date(dateText);
    if (!Number.isNaN(parsed.getTime())) {
      y = parsed.getFullYear(); m = parsed.getMonth(); d = parsed.getDate();
    }
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
    if (json.data && Array.isArray(json.data)) return json.data;
  } catch (_) {}
  return [];
}

function extractActionFromResponse(response) {
  try {
    const u = new URL(response.url());
    const action = u.searchParams.get('action');
    if (action) return action;
  } catch (_) {}
  const body = response.request().postData() || '';
  try {
    return new URLSearchParams(body).get('action') || '';
  } catch (_) {
    const m = body.match(/(?:^|&)action=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

async function getRecentOrders(page) {
  const captured = [];
  const handler = async response => {
    try {
      const url = response.url();
      if (!url.includes('/admin/ajax')) return;
      const action = extractActionFromResponse(response);
      if (!/order/i.test(action)) return;
      const rows = parseResponse(await response.text());
      if (!rows.length) return;
      captured.push({ action, rows });
      console.log('[sync] captured', action, rows.length, 'row(s)');
    } catch (e) {
      console.warn('[sync] response capture failed:', e.message);
    }
  };

  page.on('response', handler);
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5500);
  page.off('response', handler);

  const byId = new Map();
  for (const pack of captured) {
    for (const row of pack.rows) {
      const id = Array.isArray(row) ? stripHtml(row[0]) : '';
      if (id) byId.set(id, row);
    }
  }
  const rows = [...byId.values()];
  console.log('[sync] combined HungerBay rows:', rows.length);
  if (!rows.length) throw new Error('Could not capture any HungerBay order rows from the dashboard');
  return rows;
}

async function ensureLoggedIn(page) {
  hungerBayAuthStatus = { ...hungerBayAuthStatus, state: 'checking', checkedAt: new Date().toISOString(), error: null };
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const url = page.url().toLowerCase();
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (url.includes('login') || body.includes('merchant login') || body.includes('sign in')) {
    hungerBayAuthStatus = {
      state: 'expired',
      checkedAt: new Date().toISOString(),
      error: 'HungerBay session expired. Refresh hungerbay-storage.json from a successful local login.'
    };
    throw new Error('HungerBay session expired. Refresh the Render Secret File `hungerbay-storage.json` with a new session from `npm run login`.');
  }
  hungerBayAuthStatus = { state: 'authenticated', checkedAt: new Date().toISOString(), error: null };
}

function isCancelledOrder(o) {
  if (!o) return false;
  const values = [
    o.cancelled === true ? 'cancelled' : '',
    o.acceptanceStatus, o.status, o.hungerbayStatus,
    o.cancellationStatus, o.cancelStatus
  ].map(v => String(v || '').trim().toLowerCase());
  return values.some(v => v === 'cancelled' || v === 'canceled' || v.includes('cancelled') || v.includes('canceled'));
}

function isRejectedOrder(o) {
  if (!o) return false;
  const values = [o.acceptanceStatus, o.hungerbayStatus, o.status]
    .map(v => String(v || '').trim().toLowerCase());
  return values.includes('rejected') || values.includes('declined') || values.includes('decline');
}

function isDeliveredOrder(o) {
  return !!(o && o.delivered === true);
}

function isTerminalOrder(o) {
  return isCancelledOrder(o) || isRejectedOrder(o) || isDeliveredOrder(o);
}

function orderKey(o) {
  return String(o.id || o.hungerbayOrderId || o.orderNumber || 'unknown');
}

function eventId(o, event) {
  return crypto.createHash('sha256').update(`${orderKey(o)}:${event}`).digest('hex');
}

function orderDateMs(o) {
  const t = Date.parse(String(o.deliveryDateTime || ''));
  return Number.isFinite(t) ? t : NaN;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    if (typeof value.seconds === 'number') return value.seconds * 1000;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

async function getPushSubscriptions() {
  requireDb();
  const snap = await db.collection('pushSubscriptions').where('enabled', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.subscription && x.subscription.endpoint);
}

async function sendPushToAll(event, o) {
  if (isTerminalOrder(o)) return { sent: 0, skipped: true };
  const subscriptions = await getPushSubscriptions();
  let sent = 0;

  for (const rec of subscriptions) {
    const ref = db.collection('pushEvents').doc(`${rec.id}_${eventId(o, event)}`);
    if ((await ref.get()).exists) continue;

    const payload = JSON.stringify({
      event,
      orderId: orderKey(o),
      orderNumber: String(o.orderNumber || ''),
      hungerbayOrderId: String(o.hungerbayOrderId || ''),
      customerName: String(o.customerName || ''),
      description: String(o.description || ''),
      flavour: String(o.flavour || ''),
      quantity: String(o.quantity || 1),
      customerPhone: String(o.customerPhone || ''),
      customerAddress: String(o.customerAddress || ''),
      price: String(o.price || o.total || 0),
      deliveryDateTime: String(o.deliveryDateTime || ''),
      cancelled: 'false',
      url: process.env.PUSH_APP_URL || '/buddies-and-bites-ledger.html'
    });

    try {
      await webpush.sendNotification(rec.subscription, payload, { TTL: 300 });
      await ref.set({
        subscriptionId: rec.id,
        orderId: orderKey(o),
        event,
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      });
      sent++;
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 404 || status === 410) {
        await db.collection('pushSubscriptions').doc(rec.id).delete().catch(() => {});
      } else {
        console.error('[push] send failed:', status || '', err.message);
      }
    }
  }
  return { sent };
}

let pushInitialized = false;
async function scanPushEvents() {
  if (!db) return;
  const snap = await db.collection('orders').limit(500).get();
  const now = Date.now();
  let newCount = 0, dueCount = 0;

  for (const doc of snap.docs) {
    const o = { id: doc.id, ...doc.data() };
    const stateRef = db.collection('pushOrderState').doc(doc.id);
    const stateSnap = await stateRef.get();
    const previous = stateSnap.exists ? stateSnap.data() : null;

    const cancelled = isCancelledOrder(o);
    const rejected = isRejectedOrder(o);
    const delivered = isDeliveredOrder(o);
    const currentNew = !cancelled && !rejected && !delivered && o.acceptanceStatus === 'new';

    // Initial startup only alerts orders created very recently, avoiding a
    // notification storm from old pending orders.
    const createdMs = timestampMs(doc.createTime) || timestampMs(o.createdAt) || timestampMs(o.updatedAt);
    const recent = createdMs > now - PUSH_LOOKBACK_MS;
    const wasNew = previous && previous.acceptanceStatus === 'new';

    if (currentNew && ((!pushInitialized && recent) || (pushInitialized && !wasNew))) {
      const r = await sendPushToAll('new', o);
      newCount += r.sent || 0;
    }

    const dueMs = orderDateMs(o);
    if (!cancelled && !rejected && !delivered && Number.isFinite(dueMs) &&
        now >= dueMs && now < dueMs + PUSH_DUE_GRACE_MS) {
      const r = await sendPushToAll('due', o);
      dueCount += r.sent || 0;
    }

    await stateRef.set({
      acceptanceStatus: o.acceptanceStatus || null,
      cancelled, rejected, delivered,
      dueAt: Number.isFinite(dueMs) ? dueMs : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  pushInitialized = true;
  if (newCount || dueCount) console.log('[push] sent', { newCount, dueCount });
}

async function syncOnce() {
  requireDb();
  getStorageStateSource();
  const browser = await chromium.launch({ headless: true });
  const context = await newHungerBayContext(browser);
  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);
    const rows = await getRecentOrders(page);
    const mapped = rows.map(mapRow).filter(Boolean);

    const batch = db.batch();
    for (const order of mapped) {
      batch.set(db.collection('orders').doc(order.id), order, { merge: true });
    }
    if (mapped.length) await batch.commit();

    // New HungerBay orders are pushed immediately after a successful sync.
    for (const order of mapped) {
      if (order.acceptanceStatus === 'new' && !isTerminalOrder(order)) {
        await sendPushToAll('new', order);
      }
    }

    return { count: mapped.length, orderIds: mapped.map(o => o.hungerbayOrderId) };
  } finally {
    await browser.close();
  }
}

async function changeHungerBayStatus(orderId, desiredStatus) {
  requireDb();
  getStorageStateSource();

  const allowed = new Set(['accepted', 'decline', 'cancelled', 'pending', 'acknowledged']);
  const desired = String(desiredStatus || '').trim().toLowerCase();
  if (!allowed.has(desired)) throw new Error('Unsupported HungerBay status');

  const browser = await chromium.launch({ headless: true });
  const context = await newHungerBayContext(browser);
  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);
    await page.waitForTimeout(1500);

    const row = page.locator('tr').filter({ hasText: String(orderId) }).first();
    if (await row.count() === 0) {
      throw new Error(`HungerBay order ${orderId} was not found on the dashboard`);
    }

    const clickableStatus = row.locator('a,button').filter({
      hasText: /^(pending|acknowledged|accepted|cancelled|canceled|rejected|decline|paid|refunded|failed|successful)$/i
    }).first();

    if (await clickableStatus.count()) {
      await clickableStatus.click();
    } else {
      const statusCell = row.locator('td').filter({
        hasText: /pending|acknowledged|accepted|cancelled|canceled|decline|paid|refunded|failed|successful/i
      }).first();
      if (await statusCell.count()) await statusCell.click();
      else throw new Error('Could not locate the HungerBay status control for this order');
    }

    await page.waitForTimeout(400);

    const modalText = page.locator('text=Changing Order Status For Order No').first();
    if (await modalText.count() === 0) {
      throw new Error('HungerBay status dialog did not open');
    }

    const select = page.locator('select:visible').last();
    if (await select.count() === 0) throw new Error('HungerBay status dropdown was not found');

    const options = await select.locator('option').evaluateAll(opts => opts.map(o => ({ value:o.value, label:(o.textContent||'').trim() })));
    const aliases = desired === 'decline' ? ['decline','declined','rejected','reject'] : [desired];
    const match = options.find(o => aliases.some(a => o.label.toLowerCase() === a || o.value.toLowerCase() === a));
    if (!match) throw new Error(`HungerBay dropdown does not contain "${desired}"`);

    await select.selectOption(match.value);
    const submit = page.getByRole('button', { name: /^submit$/i }).last();
    if (await submit.count() === 0) throw new Error('HungerBay status Submit button was not found');

    await submit.click();
    await page.waitForTimeout(1000);

    return { ok: true, orderId: String(orderId), status: desired };
  } finally {
    await browser.close();
  }
}

function subscriptionId(subscription) {
  return crypto.createHash('sha256').update(String(subscription.endpoint)).digest('hex');
}

const app = express();
app.use((req, res, next) => {
  const allowed = process.env.SYNC_ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '100kb' }));

let lastRun = { at:null, result:null, error:null };
let running = false;

async function runSync() {
  if (running) return { skipped:true, reason:'already running' };
  running = true;
  try {
    const result = await syncOnce();
    lastRun = { at:new Date().toISOString(), result, error:null };
    console.log('[sync]', lastRun);
    return result;
  } catch (e) {
    lastRun = { at:new Date().toISOString(), result:null, error:e.message };
    console.error('[sync]', e);
    throw e;
  } finally {
    running = false;
  }
}

app.get('/health', (_req,res) => res.json({
  ok:true,
  running,
  lastRun,
  config:{
    dashboardConfigured:Boolean(DASHBOARD_URL),
    d1Configured:Boolean(D1_API_URL),
    storageStatePresent:storageStatePresent(),
    storageStatePath: STORAGE_STATE_JSON.trim() ? 'environment:HUNGERBAY_STORAGE_STATE_JSON' : STORAGE_STATE,
    hungerBayAuth: hungerBayAuthStatus,
    pushConfigured:Boolean(vapidKeys.publicKey)
  }
}));

app.get('/hungerbay/session-check', requireStaffKey, async (_req,res) => {
  let browser = null;
  try {
    getStorageStateSource();
    browser = await chromium.launch({ headless:true });
    const context = await newHungerBayContext(browser);
    const page = await context.newPage();
    await ensureLoggedIn(page);
    res.json({
      ok:true,
      state:'authenticated',
      checkedAt:hungerBayAuthStatus.checkedAt
    });
  } catch (e) {
    res.status(401).json({
      ok:false,
      state:hungerBayAuthStatus.state || 'error',
      error:e.message
    });
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});

app.post('/sync/hungerbay', requireStaffKey, async (_req,res) => {
  try { res.json({ ok:true, ...(await runSync()) }); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/hungerbay/order-status', requireStaffKey, async (req,res) => {
  try {
    const orderId=String(req.body && req.body.orderId || '').trim();
    const status=String(req.body && req.body.status || '').trim().toLowerCase();
    if(!orderId) return res.status(400).json({ok:false,error:'Missing orderId'});
    const result=await changeHungerBayStatus(orderId,status);
    res.json(result);
  } catch(e) {
    console.error('[hungerbay-status]',e);
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get('/push/config', (_req,res) => res.json({
  ok:true,
  publicVapidKey:vapidKeys.publicKey,
  appUrl:process.env.PUSH_APP_URL || '/'
}));

app.post('/push/register', requireStaffKey, async (req,res) => {
  try {
    requireDb();
    const sub=req.body && req.body.subscription;
    if(!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
      return res.status(400).json({ok:false,error:'Invalid push subscription'});
    const id=subscriptionId(sub);
    await db.collection('pushSubscriptions').doc(id).set({
      subscription:sub,
      enabled:true,
      deviceName:String(req.body.deviceName||''),
      app:String(req.body.app||'bnb-order-ledger'),
      updatedAt:admin.firestore.FieldValue.serverTimestamp()
    },{merge:true});
    res.json({ok:true,id});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.post('/push/unregister', requireStaffKey, async (req,res) => {
  try {
    requireDb();
    const endpoint=String(req.body && req.body.endpoint || '').trim();
    if(endpoint) {
      await db.collection('pushSubscriptions').doc(subscriptionId({endpoint})).delete().catch(()=>{});
    }
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.get('/push/status', requireStaffKey, async (_req,res) => {
  try {
    requireDb();
    const s=await db.collection('pushSubscriptions').where('enabled','==',true).get();
    res.json({ok:true,devices:s.size});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Buddies & Bites sync/push server listening on port ${PORT}`));

if (require.main === module) {
  if (db && storageStatePresent()) {
    setTimeout(()=>runSync().catch(()=>{}),2000);
    setInterval(()=>runSync().catch(()=>{}),POLL_MS);
  } else {
    console.log('[sync] Waiting for D1 API configuration and HungerBay storage state. /health remains available.');
  }
  if (db) {
    setTimeout(()=>scanPushEvents().catch(e=>console.error('[push]',e)),5000);
    setInterval(()=>scanPushEvents().catch(e=>console.error('[push]',e)),PUSH_SCAN_MS);
  }
}
