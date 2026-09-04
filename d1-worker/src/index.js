
const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "86400"
};

const PUBLIC_COLLECTIONS = new Set([
  "orders",
  "products",
  "customers",
  "reviews",
  "visits",
  "meta",
  "pushSubscriptions",
  "pushEvents",
  "pushOrderState"
]);

// Never expose this document through the generic API.
// It may contain an API key.
const BLOCKED_META_DOCUMENTS = new Set(["geminiConfig"]);

// These `meta` documents are customer-facing counters that the public shop
// page increments directly (order numbers, visit stats, etc). Every other
// `meta` document (shopConfig, adsBanner, categoryStatus, ...) is
// staff-editable only.
const PUBLIC_WRITE_META_DOCS = new Set([
  "orderCounter",
  "customRequestCounter",
  "visitStats"
]);

// Collections that only the HungerBay sync server talks to. Never
// reachable from the browser without the staff key, for any method.
const STAFF_ONLY_COLLECTIONS = new Set([
  "pushSubscriptions",
  "pushEvents",
  "pushOrderState"
]);

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function extractPresentedKey(request) {
  const authHeader = request.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();
  const apiKeyHeader = request.headers.get("X-Api-Key");
  if (apiKeyHeader) return apiKeyHeader.trim();
  return "";
}

function getStaffRole(request, env) {
  const presented = extractPresentedKey(request);
  if (!presented) return null;

  const master = (env.STAFF_API_KEY || "").trim();
  if (master && timingSafeEqual(presented, master)) return "master";

  const readonly = (env.STAFF_READONLY_API_KEY || "").trim();
  if (readonly && timingSafeEqual(presented, readonly)) return "readonly";

  return null;
}

function hasValidStaffKey(request, env) {
  return !!getStaffRole(request, env);
}

function orderTerminalState(data) {
  const o = data || {};
  const values = [
    o.cancelled === true ? "cancelled" : "",
    o.acceptanceStatus,
    o.status,
    o.hungerbayStatus,
    o.cancellationStatus,
    o.cancelStatus
  ].map(v => String(v || "").trim().toLowerCase());

  const cancelled = values.some(v =>
    v === "cancelled" || v === "canceled" || v.includes("cancelled") || v.includes("canceled")
  );
  const delivered = !cancelled && (o.delivered === true || String(o.status || "").trim().toLowerCase() === "completed");

  return { cancelled, delivered };
}

function terminalStatusChanged(existing, incoming) {
  const before = existing || {};
  const after = incoming || {};
  const fields = [
    "cancelled",
    "acceptanceStatus",
    "status",
    "delivered",
    "hungerbayStatus",
    "cancellationStatus",
    "cancelStatus"
  ];
  return fields.some(field => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

function requireStaffRole(request, env, minimumRole = "readonly") {
  const role = getStaffRole(request, env);
  if (!role) return { ok: false, status: 401, error: "Staff API key required" };
  if (minimumRole === "master" && role !== "master") {
    return { ok: false, status: 403, error: "Master Admin access required" };
  }
  return { ok: true, role };
}

// Decides whether a given operation requires the staff key.
// Mirrors the access model described in README-D1-MIGRATION.md:
//   public: reading products/reviews/menu config/visit counters; a
//   customer creating a new order/review, or reading/updating their own
//   customer record.
//   staff-only: listing/editing/deleting orders, listing customers in
//   bulk, editing products, deleting anything, editing shop config/ads
//   banner, anything touching the push-notification collections.
// Collections whose browser-side compat shim creates new documents by
// trying PUT first and falling back to POST on 404 (client-generated IDs —
// see d1-firestore-compat.js DocumentReference.set()). For these, a PUT
// against a document that doesn't exist yet is part of that public create
// flow and must not be blocked before the 404 fallback can run — so the
// staff-key check for PUT is deferred until *after* we know the document
// already exists (see the PUT handler below). A PUT that actually finds
// and edits an existing document still requires the staff key.
const PUT_CREATE_PROBE_COLLECTIONS = new Set(["orders", "reviews"]);

function requiresStaffKey(collection, method, id) {
  if (STAFF_ONLY_COLLECTIONS.has(collection)) return true;

  if (method === "GET") {
    if (collection === "orders" && !id) return true; // bulk order listing (the ledger)
    if (collection === "customers" && !id) return true; // bulk customer listing
    return false; // single-doc lookups, products, reviews, meta, visits
  }

  if (method === "PUT" && PUT_CREATE_PROBE_COLLECTIONS.has(collection)) {
    // Handled after the existence check inside the PUT branch instead.
    return false;
  }

  if (collection === "orders") return method !== "POST"; // create is public; edit/delete is staff
  if (collection === "customers") return method === "DELETE"; // create + self-update stay public
  if (collection === "reviews") return method !== "POST"; // leaving a review is public
  if (collection === "visits") return method === "DELETE";
  if (collection === "products") return true; // all writes staff-only
  if (collection === "meta") {
    if (id && PUBLIC_WRITE_META_DOCS.has(id)) return false;
    return true;
  }
  return true; // fail closed for any collection this rule doesn't recognize
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

function bad(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function collectionAllowed(collection) {
  return PUBLIC_COLLECTIONS.has(collection);
}

function documentAllowed(collection, id) {
  return (
    collectionAllowed(collection) &&
    !(collection === "meta" && BLOCKED_META_DOCUMENTS.has(id))
  );
}

function parseJsonBody(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must contain valid JSON");
  }
}

function serializeData(data) {
  return JSON.stringify(data ?? {});
}

async function parseRow(row, db) {
  let data = {};

  try {
    data = row.data_json ? JSON.parse(row.data_json) : {};
  } catch {
    data = {};
  }

  // Large Firestore documents are stored as a small marker in
  // firestore_documents and the original JSON is split across
  // firestore_document_chunks. Reassemble them transparently so the
  // frontend receives the original Firestore document.
  if (data && data.__chunked === true && Number(data.chunkCount) > 0) {
    try {
      const chunksResult = await db
        .prepare(`
          SELECT chunk_data
          FROM firestore_document_chunks
          WHERE collection_name = ?
            AND document_id = ?
          ORDER BY chunk_number ASC
        `)
        .bind(row.collection_name, row.document_id)
        .all();

      const chunks = chunksResult.results || [];
      if (chunks.length === Number(data.chunkCount)) {
        const combined = chunks.map(chunk => chunk.chunk_data || "").join("");
        data = JSON.parse(combined);
      }
    } catch (error) {
      console.error("Failed to reconstruct chunked Firestore document", {
        collection: row.collection_name,
        id: row.document_id,
        error: error?.message || String(error)
      });
      // Keep the marker as a safe fallback if reconstruction fails.
    }
  }

  return {
    id: row.document_id,
    collection: row.collection_name,
    data,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at
  };
}

function getLimit(url) {
  const requested = Number(url.searchParams.get("limit") || 100);

  if (!Number.isFinite(requested)) {
    return 100;
  }

  return Math.min(
    Math.max(Math.floor(requested), 1),
    500
  );
}

function matchesSince(row, since) {
  if (!since) {
    return true;
  }

  const value = Date.parse(row.updated_at || row.created_at || "");
  const cutoff = Date.parse(since);

  return (
    Number.isFinite(value) &&
    Number.isFinite(cutoff) &&
    value > cutoff
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: JSON_HEADERS
      });
    }

    try {
      // ------------------------------------------------------------
      // GET /health
      // ------------------------------------------------------------
      if (
        url.pathname === "/health" &&
        method === "GET"
      ) {
        const result = await env.DB
          .prepare("SELECT 1 AS ok")
          .first();

        return json({
          ok: result?.ok === 1,
          service: "buddiesandbites-d1-api"
        });
      }

      // ------------------------------------------------------------
      // POST /api/auth/verify
      // Verifies a staff key without exposing the secret. The key itself
      // never needs to be stored in the source repository.
      // ------------------------------------------------------------
      if (
        url.pathname === "/api/auth/verify" &&
        method === "POST"
      ) {
        const auth = requireStaffRole(request, env, "readonly");
        if (!auth.ok) return bad(auth.error, auth.status);
        return json({ ok: true, role: auth.role });
      }

      // ------------------------------------------------------------
      // POST /api-batch
      // Atomic multi-document write, used by the HungerBay sync server
      // for bulk order upserts. Staff-key only.
      // ------------------------------------------------------------
      if (
        url.pathname === "/api-batch" &&
        method === "POST"
      ) {
        const auth = requireStaffRole(request, env, "master");
        if (!auth.ok) return bad(auth.error, auth.status);

        const body = parseJsonBody(await request.text());
        const writes = Array.isArray(body.writes) ? body.writes : [];

        if (!writes.length) {
          return bad("writes must be a non-empty array", 400);
        }

        for (const w of writes) {
          if (!w || !collectionAllowed(w.collection) || !w.id) {
            return bad("Each write needs a valid collection and id", 400);
          }
        }

        const now = new Date().toISOString();
        const statements = [];

        // Upsert semantics for every write, merge or not — checked against
        // current state first rather than relying on a DB-level unique
        // constraint we can't guarantee exists across every deployment.
        for (const w of writes) {
          const existing = await env.DB
            .prepare(`SELECT data_json FROM firestore_documents WHERE collection_name = ? AND document_id = ? LIMIT 1`)
            .bind(w.collection, w.id)
            .first();

          let finalData = w.data || {};
          if (w.merge && existing) {
            let existingData = {};
            try { existingData = JSON.parse(existing.data_json || "{}"); } catch { existingData = {}; }
            finalData = { ...existingData, ...(w.data || {}) };
          }

          statements.push(
            existing
              ? env.DB.prepare(`UPDATE firestore_documents SET data_json = ?, updated_at = ? WHERE collection_name = ? AND document_id = ?`)
                  .bind(serializeData(finalData), now, w.collection, w.id)
              : env.DB.prepare(`INSERT INTO firestore_documents (collection_name, document_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
                  .bind(w.collection, w.id, serializeData(finalData), now, now)
          );
        }

        await env.DB.batch(statements);

        return json({ ok: true, count: writes.length });
      }

      // ------------------------------------------------------------
      // POST /api/ai/product-suggest
      // Staff-only. Proxies a single Gemini call so the API key never
      // reaches the browser — GEMINI_API_KEY lives only as a Worker
      // secret (`wrangler secret put GEMINI_API_KEY`).
      // ------------------------------------------------------------
      if (
        url.pathname === "/api/ai/product-suggest" &&
        method === "POST"
      ) {
        if (!hasValidStaffKey(request, env)) {
          return bad("Staff API key required", 401);
        }

        const apiKey = (env.GEMINI_API_KEY || "").trim();
        if (!apiKey) {
          return bad("AI suggestions are not configured on the server (GEMINI_API_KEY missing)", 503);
        }

        const body = parseJsonBody(await request.text());
        const prompt = String(body.prompt || "").slice(0, 4000);
        const mimeType = String(body.mimeType || "");
        const imageBase64 = String(body.imageBase64 || "");

        if (!prompt || !/^image\/[a-zA-Z]+$/.test(mimeType) || !imageBase64) {
          return bad("prompt, mimeType and imageBase64 are required", 400);
        }
        // Base64 image payloads should stay reasonably small — this is a
        // single product photo, not a bulk upload.
        if (imageBase64.length > 8_000_000) {
          return bad("Image is too large", 413);
        }

        try {
          const geminiRes = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }]
              })
            }
          );

          const geminiText = await geminiRes.text();
          if (!geminiRes.ok) {
            console.error("Gemini product-suggest error", geminiRes.status, geminiText.slice(0, 500));
            return bad("AI request failed", 502);
          }

          return new Response(geminiText, { status: 200, headers: JSON_HEADERS });
        } catch (error) {
          console.error("Gemini product-suggest fetch failed", error?.message || String(error));
          return bad("AI request failed", 502);
        }
      }

      // ------------------------------------------------------------
      // POST /api/ai/shop-chat
      // Public (the shop's customer-facing chat widget has no login),
      // but bounded in size to limit abuse/cost. Proxies to Gemini using
      // GEMINI_SHOP_API_KEY (kept separate from the staff key on purpose,
      // so it can be rotated independently without touching the staff
      // tooling — see `wrangler secret put GEMINI_SHOP_API_KEY`).
      // ------------------------------------------------------------
      if (
        url.pathname === "/api/ai/shop-chat" &&
        method === "POST"
      ) {
        const apiKey = (env.GEMINI_SHOP_API_KEY || env.GEMINI_API_KEY || "").trim();
        if (!apiKey) {
          return bad("Chat is not configured on the server", 503);
        }

        const body = parseJsonBody(await request.text());
        const systemPrompt = String(body.systemPrompt || "").slice(0, 4000);
        const contents = Array.isArray(body.contents) ? body.contents : [];

        if (!systemPrompt || !contents.length) {
          return bad("systemPrompt and contents are required", 400);
        }
        if (contents.length > 40) {
          return bad("Conversation is too long — start a new chat", 400);
        }

        const sanitizedContents = contents.slice(0, 40).map(turn => ({
          role: turn && turn.role === "model" ? "model" : "user",
          parts: [{ text: String((turn && turn.parts && turn.parts[0] && turn.parts[0].text) || "").slice(0, 2000) }]
        }));

        try {
          const geminiRes = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: sanitizedContents
              })
            }
          );

          const geminiText = await geminiRes.text();
          if (!geminiRes.ok) {
            console.error("Gemini shop-chat error", geminiRes.status, geminiText.slice(0, 500));
            return bad("AI request failed", 502);
          }

          return new Response(geminiText, { status: 200, headers: JSON_HEADERS });
        } catch (error) {
          console.error("Gemini shop-chat fetch failed", error?.message || String(error));
          return bad("AI request failed", 502);
        }
      }

      // ------------------------------------------------------------
      // GET /api/orders
      // Compatibility endpoint
      // ------------------------------------------------------------
      if (
        url.pathname === "/api/orders" &&
        method === "GET"
      ) {
        const auth = requireStaffRole(request, env, "readonly");
        if (!auth.ok) return bad(auth.error, auth.status);

        const limit = getLimit(url);
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const currentOnly = url.searchParams.get("current") === "1";

        let sql = `
          SELECT
            collection_name,
            document_id,
            data_json,
            created_at,
            updated_at
          FROM firestore_documents
          WHERE collection_name = 'orders'
        `;
        const binds = [];

        // The Ledger's default view deliberately excludes historical orders.
        // Delivered/past orders are loaded only when the user supplies a date range.
        // Active/unresolved orders remain visible even when their delivery date is old.
        if (currentOnly) {
          sql += `
            AND (
              (json_extract(data_json, '$.delivered') IS NOT 1
               AND COALESCE(json_extract(data_json, '$.status'), '') != 'completed')
              OR json_extract(data_json, '$.deliveryDateTime') IS NULL
              OR json_extract(data_json, '$.deliveryDateTime') >= ?
            )
          `;
          binds.push(new Date().toISOString().slice(0, 10) + 'T00:00:00');
        } else if (from && to) {
          sql += `
            AND json_extract(data_json, '$.deliveryDateTime') >= ?
            AND json_extract(data_json, '$.deliveryDateTime') < ?
          `;
          binds.push(from + 'T00:00:00', to + 'T23:59:59.999');
        }

        sql += ' ORDER BY updated_at DESC LIMIT ?';
        binds.push(limit);

        const result = await env.DB.prepare(sql).bind(...binds).all();

        const orders = await Promise.all((result.results || []).map(row => parseRow(row, env.DB)));

        return json({
          ok: true,
          count: orders.length,
          orders
        });
      }

      // ------------------------------------------------------------
      // GET /api/changes?collection=orders&since=ISO_TIMESTAMP
      //
      // Use the server-maintained updated_at timestamp so polling clients
      // see both new and modified documents.
      // ------------------------------------------------------------
      if (
        url.pathname === "/api/changes" &&
        method === "GET"
      ) {
        const collection =
          url.searchParams.get("collection");

        const since =
          url.searchParams.get("since");

        if (
          !collection ||
          !collectionAllowed(collection)
        ) {
          return bad(
            "Unsupported or missing collection",
            400
          );
        }

        if (requiresStaffKey(collection, "GET", null) && !hasValidStaffKey(request, env)) {
          return bad("Staff API key required", 401);
        }

        const limit = getLimit(url);
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const currentOnly = url.searchParams.get("current") === "1";

        // When a cursor is supplied, filter in D1 itself instead of loading
        // the whole collection and filtering in the browser. This keeps the
        // Ledger fast even when there are many historical orders.
        let result;
        const dateClause = currentOnly
          ? ` AND (
                (json_extract(data_json, '$.delivered') IS NOT 1
                 AND COALESCE(json_extract(data_json, '$.status'), '') != 'completed')
                OR json_extract(data_json, '$.deliveryDateTime') IS NULL
                OR json_extract(data_json, '$.deliveryDateTime') >= ?
              )`
          : (from && to)
            ? ` AND json_extract(data_json, '$.deliveryDateTime') >= ?
                AND json_extract(data_json, '$.deliveryDateTime') < ?`
            : '';

        const dateBinds = currentOnly
          ? [new Date().toISOString().slice(0, 10) + 'T00:00:00']
          : (from && to) ? [from + 'T00:00:00', to + 'T23:59:59.999'] : [];

        if (since && Number.isFinite(Date.parse(since))) {
          result = await env.DB
            .prepare(`
              SELECT
                collection_name,
                document_id,
                data_json,
                created_at,
                updated_at
              FROM firestore_documents
              WHERE collection_name = ?
                AND updated_at > ?${dateClause}
              ORDER BY updated_at ASC
              LIMIT ?
            `)
            .bind(collection, since, ...dateBinds, limit)
            .all();
        } else {
          result = await env.DB
            .prepare(`
              SELECT
                collection_name,
                document_id,
                data_json,
                created_at,
                updated_at
              FROM firestore_documents
              WHERE collection_name = ?${dateClause}
              ORDER BY updated_at ASC
              LIMIT ?
            `)
            .bind(collection, ...dateBinds, limit)
            .all();
        }

        const changes = await Promise.all(
          (result.results || []).map(row => parseRow(row, env.DB))
        );

        return json({
          ok: true,
          collection,
          since: since || null,
          count: changes.length,
          changes,
          serverTime: new Date().toISOString()
        });
      }

      // ------------------------------------------------------------
      // Generic API route
      //
      // /api/:collection
      // /api/:collection/:id
      // ------------------------------------------------------------
      const match = url.pathname.match(
        /^\/api\/([^/]+)(?:\/([^/]+))?\/?$/
      );

      if (!match) {
        return bad("Not found", 404);
      }

      const collection =
        decodeURIComponent(match[1]);

      const id =
        match[2]
          ? decodeURIComponent(match[2])
          : null;

      if (!collectionAllowed(collection)) {
        return bad(
          "Unsupported collection",
          403
        );
      }

      if (
        id &&
        !documentAllowed(collection, id)
      ) {
        return bad(
          "This document is not available through the API",
          403
        );
      }

      if (requiresStaffKey(collection, method, id)) {
        const auth = requireStaffRole(request, env, "readonly");
        if (!auth.ok) return bad(auth.error, auth.status);
        if (auth.role === "readonly" && method !== "GET") {
          return bad("Read-only staff access", 403);
        }
      }

      // ------------------------------------------------------------
      // GET collection
      // ------------------------------------------------------------
      if (
        method === "GET" &&
        !id
      ) {
        const limit = getLimit(url);

        const result = await env.DB
          .prepare(`
            SELECT
              collection_name,
              document_id,
              data_json,
              created_at,
              updated_at
            FROM firestore_documents
            WHERE collection_name = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `)
          .bind(collection, limit)
          .all();

        const documents = await Promise.all(
          (result.results || []).map(row => parseRow(row, env.DB))
        );

        return json({
          ok: true,
          collection,
          count: documents.length,
          documents
        });
      }

      // ------------------------------------------------------------
      // GET one document
      // ------------------------------------------------------------
      if (
        method === "GET" &&
        id
      ) {
        const row = await env.DB
          .prepare(`
            SELECT
              collection_name,
              document_id,
              data_json,
              created_at
            FROM firestore_documents
            WHERE collection_name = ?
              AND document_id = ?
            LIMIT 1
          `)
          .bind(collection, id)
          .first();

        if (!row) {
          return bad(
            "Document not found",
            404
          );
        }

        return json({
          ok: true,
          document: await parseRow(row, env.DB)
        });
      }

      if (
        !["POST", "PUT", "PATCH", "DELETE"]
          .includes(method)
      ) {
        return bad(
          "Method not allowed",
          405
        );
      }

      // ------------------------------------------------------------
      // POST /api/:collection
      // ------------------------------------------------------------
      if (
        method === "POST" &&
        !id
      ) {
        const body =
          parseJsonBody(await request.text());

        const documentId =
          body.id || crypto.randomUUID();

        const data =
          Object.prototype.hasOwnProperty.call(
            body,
            "data"
          )
            ? body.data
            : body;

        const now =
          new Date().toISOString();

        await env.DB
          .prepare(`
            INSERT INTO firestore_documents
              (
                collection_name,
                document_id,
                data_json,
                created_at,
                updated_at
              )
            VALUES (?, ?, ?, ?, ?)
          `)
          .bind(
            collection,
            documentId,
            serializeData(data),
            now,
            now
          )
          .run();

        return json(
          {
            ok: true,
            document: {
              id: documentId,
              collection,
              data,
              created_at: now
            }
          },
          201
        );
      }

      if (!id) {
        return bad(
          "A document id is required for this operation",
          400
        );
      }

      // ------------------------------------------------------------
      // DELETE /api/:collection/:id
      // ------------------------------------------------------------
      if (method === "DELETE") {
        const result = await env.DB
          .prepare(`
            DELETE FROM firestore_documents
            WHERE collection_name = ?
              AND document_id = ?
          `)
          .bind(collection, id)
          .run();

        if (!result.meta?.changes) {
          return bad(
            "Document not found",
            404
          );
        }

        return json({
          ok: true,
          deleted: {
            collection,
            id
          }
        });
      }

      // ------------------------------------------------------------
      // PUT /api/:collection/:id
      // ------------------------------------------------------------
      const body =
        parseJsonBody(await request.text());

      const data =
        Object.prototype.hasOwnProperty.call(
          body,
          "data"
        )
          ? body.data
          : body;

      if (method === "PUT") {
        const existing = await env.DB
          .prepare(`
            SELECT created_at
            FROM firestore_documents
            WHERE collection_name = ?
              AND document_id = ?
            LIMIT 1
          `)
          .bind(collection, id)
          .first();

        if (!existing) {
          // Lets the browser shim's create-via-PUT-then-POST-fallback flow
          // work for public collections (new orders, new reviews) without
          // ever needing the staff key just to find out the doc is new.
          return bad(
            "Document not found",
            404
          );
        }

        // The document already exists, so this is a genuine edit — now
        // enforce the staff key for collections that require it.
        if (PUT_CREATE_PROBE_COLLECTIONS.has(collection)) {
          const auth = requireStaffRole(request, env, "master");
          if (!auth.ok) return bad(auth.error, auth.status);
        }

        if (collection === "orders") {
          let existingData = {};
          try { existingData = JSON.parse(existing.data_json || "{}"); } catch { existingData = {}; }
          const terminal = orderTerminalState(existingData);
          if ((terminal.delivered || terminal.cancelled) && terminalStatusChanged(existingData, data)) {
            return bad(
              terminal.cancelled
                ? "Cancelled orders are terminal and their status cannot be changed"
                : "Delivered orders are terminal and their status cannot be changed",
              403
            );
          }
        }

        await env.DB
          .prepare(`
            UPDATE firestore_documents
            SET data_json = ?, updated_at = ?
            WHERE collection_name = ?
              AND document_id = ?
          `)
          .bind(
            serializeData(data),
            new Date().toISOString(),
            collection,
            id
          )
          .run();

        return json({
          ok: true,
          document: {
            id,
            collection,
            data,
            created_at: existing.created_at
          }
        });
      }

      // ------------------------------------------------------------
      // PATCH /api/:collection/:id
      //
      // Firestore-like merge.
      // ------------------------------------------------------------
      const existing = await env.DB
        .prepare(`
          SELECT
            data_json,
            created_at
          FROM firestore_documents
          WHERE collection_name = ?
            AND document_id = ?
          LIMIT 1
        `)
        .bind(collection, id)
        .first();

      if (!existing) {
        return bad(
          "Document not found",
          404
        );
      }

      let existingData = {};

      try {
        existingData =
          JSON.parse(
            existing.data_json || "{}"
          );
      } catch {
        existingData = {};
      }

      const merged = {
        ...existingData,
        ...data
      };

      // Delivered and cancelled orders are terminal. Their status cannot be
      // changed by staff once that terminal state has been reached. Other
      // non-status fields may still be edited. This is enforced server-side
      // so the rule cannot be bypassed by calling the API directly.
      if (collection === "orders") {
        const terminal = orderTerminalState(existingData);
        if ((terminal.delivered || terminal.cancelled) && terminalStatusChanged(existingData, merged)) {
          return bad(
            terminal.cancelled
              ? "Cancelled orders are terminal and their status cannot be changed"
              : "Delivered orders are terminal and their status cannot be changed",
            403
          );
        }
      }

      await env.DB
        .prepare(`
          UPDATE firestore_documents
          SET data_json = ?, updated_at = ?
          WHERE collection_name = ?
            AND document_id = ?
        `)
        .bind(
          serializeData(merged),
          new Date().toISOString(),
          collection,
          id
        )
        .run();

      return json({
        ok: true,
        document: {
          id,
          collection,
          data: merged,
          created_at: existing.created_at
        }
      });

    } catch (error) {
      console.error(
        "D1 API error",
        error
      );

      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Internal server error"
        },
        500
      );
    }
  }
};