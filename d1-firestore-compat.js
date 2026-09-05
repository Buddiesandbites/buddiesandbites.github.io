/* Buddies & Bites - Firestore compatibility layer backed by Cloudflare D1 API. */
(function (global) {
  'use strict';

  const API_BASE = 'https://buddiesandbites-d1-api.buddiesandbites.workers.dev';
  const POLL_MS = 10000;
  const STAFF_KEY_STORAGE_KEY = 'bnb_staff_key';

  function apiUrl(path) { return API_BASE + path; }
  function encode(v) { return encodeURIComponent(String(v)); }
  function staffKeyHeaders() {
    // Only present on pages where the person has logged in via
    // buddies-and-bites-login.html (shop.html never sets this). Sending it
    // on public requests too is harmless — the Worker only checks it when
    // the operation actually requires it.
    try {
      const key = window.localStorage && localStorage.getItem(STAFF_KEY_STORAGE_KEY);
      return key ? { Authorization: 'Bearer ' + key } : {};
    } catch (_) { return {}; }
  }
  async function request(path, options) {
    const res = await fetch(apiUrl(path), {
      headers: { 'Content-Type': 'application/json', ...staffKeyHeaders(), ...(options && options.headers || {}) },
      ...(options || {})
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok || (body && body.ok === false)) {
      const err = new Error((body && body.error) || ('D1 API request failed: ' + res.status));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function deepClone(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(deepClone);
    const o = {};
    Object.keys(v).forEach(k => o[k] = deepClone(v[k]));
    return o;
  }

  function resolveSpecial(value, current) {
    if (value && typeof value === 'object') {
      if (value.__d1FieldValue === 'increment') {
        return Number(current || 0) + Number(value.value || 0);
      }
      if (value.__d1FieldValue === 'serverTimestamp') return new Date().toISOString();
      if (Array.isArray(value)) return value.map((x, i) => resolveSpecial(x, current && current[i]));
      const out = {};
      Object.keys(value).forEach(k => out[k] = resolveSpecial(value[k], current && current[k]));
      return out;
    }
    return value;
  }

  class DocumentSnapshot {
    constructor(ref, row) {
      this.ref = ref;
      this.id = ref.id;
      this._row = row || null;
      this.exists = !!row;
    }
    data() { return this.exists ? deepClone(this._row.data || {}) : undefined; }
  }

  class QuerySnapshot {
    constructor(refs, rows, changes) {
      this.docs = (rows || []).map(row => new DocumentSnapshot(refs.doc(row.id), row));
      this._changes = changes || null;
      this.size = this.docs.length;
      this.empty = this.size === 0;
    }
    forEach(cb) { this.docs.forEach(cb); }
    docChanges() {
      if (this._changes) return this._changes;
      // The D1 polling layer does not have Firestore's native change stream.
      // Return a Firestore-compatible 'added' change for the current snapshot.
      return this.docs.map(doc => ({ type: 'added', doc }));
    }
  }

  class DocumentReference {
    constructor(collection, id) { this.collection = collection; this.id = String(id); }
    get path() { return this.collection.name + '/' + this.id; }
    async get() {
      try {
        const body = await request('/api/' + encode(this.collection.name) + '/' + encode(this.id));
        return new DocumentSnapshot(this, body.document);
      } catch (e) {
        if (e.status === 404) return new DocumentSnapshot(this, null);
        throw e;
      }
    }
    async set(data, options) {
      const clean = deepClone(data || {});
      let existing = null;
      if (options && options.merge) {
        try { existing = await this.get(); } catch (_) {}
      }
      const payload = options && options.merge && existing && existing.exists
        ? resolveSpecial(clean, existing.data())
        : resolveSpecial(clean, existing && existing.exists ? existing.data() : {});
      if (options && options.merge) {
        try {
          await request('/api/' + encode(this.collection.name) + '/' + encode(this.id), {
            method: 'PATCH', body: JSON.stringify(payload)
          });
          return;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      } else {
        try {
          await request('/api/' + encode(this.collection.name) + '/' + encode(this.id), {
            method: 'PUT', body: JSON.stringify(payload)
          });
          return;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      await request('/api/' + encode(this.collection.name), {
        method: 'POST', body: JSON.stringify({ id: this.id, data: payload })
      });
    }
    async update(data) { return this.set(data, { merge: true }); }
    async delete() {
      await request('/api/' + encode(this.collection.name) + '/' + encode(this.id), { method: 'DELETE' });
    }
    onSnapshot(success, error) {
      let stopped = false, last = '';
      const poll = async () => {
        if (stopped) return;
        try {
          const snap = await this.get();
          const key = JSON.stringify(snap.exists ? snap.data() : null);
          if (key !== last) { last = key; success(snap); }
        } catch (e) { if (error) error(e); }
        if (!stopped) setTimeout(poll, POLL_MS);
      };
      poll();
      return () => { stopped = true; };
    }
  }

  class Query {
    constructor(collection) { this.collection = collection; this._order = null; this._limit = 100; this._currentOnly = false; this._from = null; this._to = null; }
    orderBy(field, direction) { this._order = { field, direction: direction || 'asc' }; return this; }
    currentOnly(enabled = true) { this._currentOnly = !!enabled; return this; }
    dateRange(from, to) { this._from = from || null; this._to = to || null; this._currentOnly = false; return this; }
    limit(n) { this._limit = Math.min(Math.max(Number(n) || 100, 1), 500); return this; }
    where(field, op, value) { this._where = { field, op, value }; return this; }
    async get() {
      let params = new URLSearchParams({ limit: String(this._limit) });
      if (this._currentOnly) params.set('current', '1');
      if (this._from && this._to) { params.set('from', this._from); params.set('to', this._to); }
      let body = await request('/api/' + encode(this.collection.name) + '?' + params.toString());
      let rows = (body.documents || body.orders || []).map(x => ({ id: x.id, data: x.data, created_at: x.created_at, updated_at: x.updated_at }));
      if (this._where) {
        const { field, op, value } = this._where;
        rows = rows.filter(r => op === '==' ? r.data && r.data[field] === value : true);
      }
      if (this._order) {
        const f = this._order.field, dir = this._order.direction === 'desc' ? -1 : 1;
        rows.sort((a,b) => {
          const av = a.data && a.data[f], bv = b.data && b.data[f];
          const ax = Date.parse(av), bx = Date.parse(bv);
          const aa = Number.isFinite(ax) ? ax : av, bb = Number.isFinite(bx) ? bx : bv;
          return (aa < bb ? -1 : aa > bb ? 1 : 0) * dir;
        });
      }
      return new QuerySnapshot(this.collection, rows.slice(0, this._limit));
    }
    onSnapshot(success, error) {
      let stopped = false;
      let current = new Map();
      let initialized = false;

      const applyQueryRules = (rows) => {
        let out = rows.slice();

        if (this._where) {
          const { field, op, value } = this._where;
          out = out.filter(r => op === '==' ? r.data && r.data[field] === value : true);
        }

        if (this._order) {
          const f = this._order.field, dir = this._order.direction === 'desc' ? -1 : 1;
          out.sort((a,b) => {
            const av = a.data && a.data[f], bv = b.data && b.data[f];
            const ax = Date.parse(av), bx = Date.parse(bv);
            const aa = Number.isFinite(ax) ? ax : av, bb = Number.isFinite(bx) ? bx : bv;
            return (aa < bb ? -1 : aa > bb ? 1 : 0) * dir;
          });
        } else {
          // The Worker returns newest-updated first; retain that useful
          // ordering when no explicit orderBy() is supplied.
          out.sort((a,b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
        }

        return out.slice(0, this._limit);
      };

      const makeSnapshot = (rows, changeRows, initial, previous) => {
        const filtered = applyQueryRules(rows);
        const changeMap = new Map((changeRows || []).map(r => [r.id, r]));
        const refs = this.collection;
        const changes = initial
          ? filtered.map(r => ({ type: 'added', doc: new DocumentSnapshot(refs.doc(r.id), r) }))
          : filtered
              .filter(r => changeMap.has(r.id))
              .map(r => ({
                type: previous && previous.has(r.id) ? 'modified' : 'added',
                doc: new DocumentSnapshot(refs.doc(r.id), r)
              }));
        return new QuerySnapshot(refs, filtered, changes);
      };

      const poll = async () => {
        if (stopped) return;
        try {
          // Every cycle re-runs the same full query used for the initial
          // load, instead of relying on a "what changed since X" cursor.
          // This costs one extra small request per cycle but guarantees new
          // and edited orders always show up on the next tick, with no
          // dependency on server/client clocks or a since-cursor staying in
          // sync.
          if (this.collection.name === 'orders') {
            const snap = await this.get();
            const rows = snap.docs.map(d => ({
              id: d.id, data: d.data(),
              updated_at: d._row && d._row.updated_at,
              created_at: d._row && d._row.created_at
            }));
            const previous = new Map(current);
            current = new Map(rows.map(r => [r.id, r]));
            success(makeSnapshot(rows, rows, !initialized, previous));
            initialized = true;
          } else {
            const snap = await this.get();
            const key = JSON.stringify(snap.docs.map(d => ({ id:d.id, data:d.data() })));
            if (!initialized || key !== JSON.stringify(Array.from(current.values()).map(r => ({id:r.id,data:r.data})))) {
              const rows = snap.docs.map(d => ({id:d.id,data:d.data(),updated_at:d._row&&d._row.updated_at,created_at:d._row&&d._row.created_at}));
              current = new Map(rows.map(r => [r.id,r]));
              initialized = true;
              success(snap);
            }
          }
        } catch (e) {
          if (error) error(e);
        }
        if (!stopped) setTimeout(poll, POLL_MS);
      };

      poll();
      return () => { stopped = true; };
    }
    doc(id) { return new DocumentReference(this.collection, id); }
  }

  class CollectionReference extends Query {
    constructor(name) {
      super(null);
      this.name = name;
      this.collection = this;
      // The Order Ledger can contain more than 100 orders. Keep the
      // compatibility layer from silently truncating its initial snapshot.
      if (name === 'orders') this._limit = 500;
    }
    doc(id) { return new DocumentReference(this, id); }
    async add(data) {
      const id = (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('d1-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      const ref = this.doc(id);
      await ref.set(data);
      return ref;
    }
  }

  class Transaction {
    constructor() { this.writes = []; }
    async get(ref) { return ref.get(); }
    set(ref, data, options) { this.writes.push(() => ref.set(data, options)); }
    update(ref, data) { this.writes.push(() => ref.update(data)); }
    delete(ref) { this.writes.push(() => ref.delete()); }
    async commit() { for (const write of this.writes) await write(); }
  }

  class WriteBatch extends Transaction {}

  const FieldValue = {
    increment: value => ({ __d1FieldValue: 'increment', value: Number(value) || 0 }),
    serverTimestamp: () => ({ __d1FieldValue: 'serverTimestamp' })
  };

  function firestore() {
    return {
      collection: name => new CollectionReference(name),
      runTransaction: async callback => { const tx = new Transaction(); const result = await callback(tx); await tx.commit(); return result; },
      batch: () => new WriteBatch()
    };
  }

  global.firebase = {
    firestore: Object.assign(firestore, { FieldValue }),
    initializeApp: function () { return { name: '[DEFAULT]' }; }
  };
  global.firebase.firestore.FieldValue = FieldValue;
})(window);
