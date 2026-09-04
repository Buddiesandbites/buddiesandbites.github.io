const fs = require("fs");
const path = require("path");

const BACKUP = path.join(
  __dirname,
  "firestore-backup-2026-08-24T07-38-51-437Z",
  "collections"
);

const OUT = path.join(__dirname, "d1-remaining-import");

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

function sqlString(value) {
  return "'" + String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\u0000/g, "") + "'";
}

fs.mkdirSync(OUT, { recursive: true });

console.log("==============================================");
console.log("BUDDIES & BITES - REMAINING DOCUMENT PREPARATION");
console.log("==============================================");
console.log("");
console.log("This creates SQL only.");
console.log("NO DATABASE WILL BE MODIFIED.");
console.log("");

let total = 0;

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

    // We intentionally do NOT regenerate the large chunked
    // documents here. Those have already been imported.
    if (json.length > 10000) {
      continue;
    }

    const sql =
      `INSERT OR REPLACE INTO firestore_documents ` +
      `(collection_name, document_id, data_json, created_at) VALUES (` +
      `${sqlString(backup.collection)},` +
      `${sqlString(doc.id)},` +
      `${sqlString(json)},` +
      `${sqlString(backup.exportedAt)}` +
      `);`;

    const number = String(total + 1).padStart(4, "0");

    fs.writeFileSync(
      path.join(OUT, `document-${number}.sql`),
      sql,
      "utf8"
    );

    total++;
  }
}

console.log("");
console.log("==============================================");
console.log("REMAINING IMPORT FILES READY");
console.log("==============================================");
console.log(`Small documents prepared: ${total}`);
console.log(`Output: ${OUT}`);
console.log("");
console.log("NO DATABASE HAS BEEN MODIFIED.");