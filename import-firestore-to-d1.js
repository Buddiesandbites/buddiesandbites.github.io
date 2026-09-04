const fs = require("fs");
const path = require("path");

const BACKUP = path.join(
  __dirname,
  "firestore-backup-2026-08-24T07-38-51-437Z",
  "collections"
);

const OUT = path.join(__dirname, "d1-import");

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

const BATCH_SIZE = 1;

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";

  return "'" + String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\u0000/g, "") + "'";
}

function jsonString(value) {
  return sqlString(JSON.stringify(value));
}

fs.mkdirSync(OUT, { recursive: true });

let allDocuments = [];
let total = 0;

console.log("==============================================");
console.log("BUDDIES & BITES â†’ D1 IMPORT PREPARATION");
console.log("==============================================");
console.log("");

for (const file of files) {
  const fullPath = path.join(BACKUP, file);

  if (!fs.existsSync(fullPath)) {
    throw new Error("Missing backup file: " + fullPath);
  }

  const backup = JSON.parse(fs.readFileSync(fullPath, "utf8"));

  console.log(
    `${backup.collection}: ${backup.documentCount} document(s)`
  );

  for (const doc of backup.documents || []) {
    allDocuments.push({
      collection: backup.collection,
      id: doc.id,
      data: doc.data,
      exportedAt: backup.exportedAt
    });

    total++;
  }
}

console.log("");
console.log(`TOTAL DOCUMENTS FOUND: ${total}`);
console.log("");

for (let i = 0; i < allDocuments.length; i += BATCH_SIZE) {
  const batch = allDocuments.slice(i, i + BATCH_SIZE);
  const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

  let sql = "";

  sql += "BEGIN TRANSACTION;\n";

  for (const doc of batch) {
    const createdAt =
      typeof doc.data?.createdAt === "string"
        ? doc.data.createdAt
        : doc.exportedAt;

    sql +=
      "INSERT OR REPLACE INTO firestore_documents " +
      "(collection_name, document_id, data_json, created_at) VALUES (" +
      sqlString(doc.collection) +
      ", " +
      sqlString(doc.id) +
      ", " +
      jsonString(doc.data) +
      ", " +
      sqlString(createdAt) +
      ");\n";
  }

  sql += "COMMIT;\n";

  const filename =
    `batch-${String(batchNumber).padStart(2, "0")}.sql`;

  fs.writeFileSync(
    path.join(OUT, filename),
    sql,
    "utf8"
  );

  console.log(
    `Created ${filename}: ${batch.length} document(s)`
  );
}

const manifest = {
  source: BACKUP,
  totalDocuments: total,
  batchSize: BATCH_SIZE,
  batchCount: Math.ceil(total / BATCH_SIZE),
  generatedAt: new Date().toISOString()
};

fs.writeFileSync(
  path.join(OUT, "import-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

console.log("");
console.log("==============================================");
console.log("IMPORT FILES READY");
console.log("==============================================");
console.log(`Documents: ${total}`);
console.log(`Batch size: ${BATCH_SIZE}`);
console.log(
  `SQL batches: ${Math.ceil(total / BATCH_SIZE)}`
);
console.log(`Output: ${OUT}`);
console.log("");
console.log("NO DATABASE HAS BEEN MODIFIED.");
