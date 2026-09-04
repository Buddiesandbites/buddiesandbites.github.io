const fs = require("fs");
const path = require("path");

const BACKUP = path.join(
  __dirname,
  "firestore-backup-2026-08-24T07-38-51-437Z",
  "collections"
);

const OUT = path.join(__dirname, "d1-chunk-import");

const files = [
  "customers.json",
  "meta.json",
  "orders.json",
  "products.json",
  "pushEvents.json",
  "pushOrderState.json",
  "pushSubscriptions.json",
  "reviews.json",
  "visits.json"
];

// Keep SQL statements comfortably below D1's statement-size limit.
const CHUNK_SIZE = 10000;

function sqlString(value) {
  return "'" + String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\u0000/g, "") + "'";
}

fs.mkdirSync(OUT, { recursive: true });

let total = 0;
let chunks = 0;

for (const file of files) {
  const fullPath = path.join(BACKUP, file);

  if (!fs.existsSync(fullPath)) {
    throw new Error("Missing backup file: " + fullPath);
  }

  const backup = JSON.parse(
    fs.readFileSync(fullPath, "utf8")
  );

  console.log(
    `${backup.collection}: ${backup.documentCount} document(s)`
  );

  for (const doc of backup.documents || []) {
    const json = JSON.stringify(doc.data);

    // Small documents stay in firestore_documents.
    if (json.length <= CHUNK_SIZE) {
      const sql =
        `INSERT OR REPLACE INTO firestore_documents ` +
        `(collection_name, document_id, data_json, created_at) VALUES (` +
        `${sqlString(backup.collection)},` +
        `${sqlString(doc.id)},` +
        `${sqlString(json)},` +
        `${sqlString(backup.exportedAt)}` +
        `);`;

      fs.writeFileSync(
        path.join(
          OUT,
          `document-${String(total + 1).padStart(4, "0")}.sql`
        ),
        sql,
        "utf8"
      );

      total++;
      continue;
    }

    // Large documents are split into chunks.
    let chunkNumber = 0;

    for (let i = 0; i < json.length; i += CHUNK_SIZE) {
      const chunk = json.slice(i, i + CHUNK_SIZE);

      const sql =
        `INSERT OR REPLACE INTO firestore_document_chunks ` +
        `(collection_name, document_id, chunk_number, chunk_data) VALUES (` +
        `${sqlString(backup.collection)},` +
        `${sqlString(doc.id)},` +
        `${chunkNumber},` +
        `${sqlString(chunk)}` +
        `);`;

      fs.writeFileSync(
        path.join(
          OUT,
          `chunk-${String(chunks + 1).padStart(5, "0")}.sql`
        ),
        sql,
        "utf8"
      );

      chunkNumber++;
      chunks++;
    }

    // Store a small marker in the main table so we know this
    // document exists and is stored in chunks.
    const marker = JSON.stringify({
      __chunked: true,
      chunkCount: chunkNumber
    });

    const markerSql =
      `INSERT OR REPLACE INTO firestore_documents ` +
      `(collection_name, document_id, data_json, created_at) VALUES (` +
      `${sqlString(backup.collection)},` +
      `${sqlString(doc.id)},` +
      `${sqlString(marker)},` +
      `${sqlString(backup.exportedAt)}` +
      `);`;

    fs.writeFileSync(
      path.join(
        OUT,
        `document-${String(total + 1).padStart(4, "0")}-marker.sql`
      ),
      markerSql,
      "utf8"
    );

    total++;
  }
}

console.log("");
console.log("==============================================");
console.log("CHUNKED IMPORT PREPARATION COMPLETE");
console.log("==============================================");
console.log(`Documents: ${total}`);
console.log(`Chunks: ${chunks}`);
console.log(`Output: ${OUT}`);
console.log("");
console.log("NO DATABASE HAS BEEN MODIFIED.");