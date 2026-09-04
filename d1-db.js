/**
 * Minimal Firestore-compatible client for Node, backed by the D1 Worker API.
 * Mirrors just the surface hungerbay-sync-server.js uses:
 *   db.collection(name).doc(id).get()/.set(data,{merge})/.delete()
 *   db.collection(name).where(field,'==',value).get()
 *   db.collection(name).limit(n).get()
 *   db.batch().set(ref, data, {merge}).../.commit()
 *
 * KNOWN LIMITATION: db.batch() sends everything to the Worker's /api-batch
 * endpoint, which IS atomic (a real D1 batch()) — unlike the browser-side
 * shim's runTransaction(), this one genuinely commits all-or-nothing.
 * where() only supports '==' and is applied client-side after fetching the
 * whole collection (fine at this project's scale; would need a real query
 * endpoint if a collection grew into the tens of thousands of documents).
 */
function createD1Db({ apiBase, apiKey }) {
  if (!apiBase) throw new Error('createD1Db requires apiBase');
  if (!apiKey) throw new Error('createD1Db requires apiKey (the STAFF_API_KEY)');
  const base = apiBase.replace(/\/$/, '');

  async function request(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `D1 request failed (${res.status})`);
    }
    return payload;
  }

  function docSnap(id, data, exists) {
    return { id, exists: !!exists, data: () => (exists ? data : undefined) };
  }

  function docRef(collection, id) {
    return {
      id,
      _collection: collection,
      async get() {
        try {
          const res = await request('GET', `/api/${collection}/${encodeURIComponent(id)}`);
          return docSnap(id, res.document.data, true);
        } catch (e) {
          if (String(e.message).toLowerCase().includes('not found')) return docSnap(id, undefined, false);
          throw e;
        }
      },
      async set(data, options) {
        const merge = !!(options && options.merge);
        await request(merge ? 'PATCH' : 'PUT', `/api/${collection}/${encodeURIComponent(id)}`, data);
      },
      async delete() {
        await request('DELETE', `/api/${collection}/${encodeURIComponent(id)}`);
      }
    };
  }

  function collectionRef(collection) {
    let filters = [];
    let limitN = 200;

    const self = {
      doc(id) { return docRef(collection, id); },
      where(field, op, value) {
        if (op !== '==') throw new Error('This client only supports "==" filters');
        filters = [...filters, { field, value }];
        return self;
      },
      limit(n) { limitN = n; return self; },
      async get() {
        const res = await request('GET', `/api/${collection}?limit=${encodeURIComponent(limitN)}`);
        let docs = (res.documents || []).map(d => ({ id: d.id, data: () => d.data, createTime: d.created_at }));
        for (const f of filters) {
          docs = docs.filter(d => d.data()[f.field] === f.value);
        }
        return {
          docs,
          size: docs.length,
          forEach(cb) { docs.forEach(cb); }
        };
      }
    };
    return self;
  }

  return {
    collection: collectionRef,
    batch() {
      const writes = [];
      return {
        set(ref, data, options) {
          writes.push({ collection: ref._collection, id: ref.id, data, merge: !(options && options.merge === false) });
        },
        async commit() {
          if (!writes.length) return;
          await request('POST', '/api-batch', { writes });
        }
      };
    }
  };
}

module.exports = { createD1Db };
