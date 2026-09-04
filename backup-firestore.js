const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Buddies & Bites — SAFE FIRESTORE BACKUP
// Read-only. Does NOT call db.listCollections().
// Uses only collection names confirmed in the current project.

const credentialFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE
  ? path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_FILE)
  : path.join(__dirname, 'firebase-backup-key.json');

if (!fs.existsSync(credentialFile)) {
  console.error('ERROR: Firebase service-account JSON not found:');
  console.error(credentialFile);
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
} catch (e) {
  console.error('ERROR: Cannot read service-account JSON:', e.message);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const backupRoot = path.join(__dirname, 'firestore-backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
const collectionsDir = path.join(backupRoot, 'collections');
fs.mkdirSync(collectionsDir, { recursive: true });

// Confirmed from the supplied Buddies & Bites project.
const COLLECTIONS = [
  'products',
  'orders',
  'customers',
  'reviews',
  'visits',
  'meta',
  'pushSubscriptions',
  'pushEvents',
  'pushOrderState'
];

const DELAY_MS = 3000;
const RETRIES = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function serializeValue(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds.toString(), nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geoPoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type: 'documentReference', path: value.path };
  }
  if (Buffer.isBuffer(value)) return { __type: 'bytes', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

function retryable(err) {
  const c = err && (err.code ?? err.status);
  const msg = String(err && err.message || '').toLowerCase();
  return c === 4 || c === 8 || c === 10 || c === 13 || c === 14 || c === 429 ||
    c === 'resource-exhausted' || msg.includes('resource_exhausted') || msg.includes('quota exceeded');
}

async function readCollection(name) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      console.log(`[read] ${name}: requesting documents (attempt ${attempt}/${RETRIES})`);
      const snap = await db.collection(name).get();
      return snap;
    } catch (err) {
      last = err;
      if (!retryable(err) || attempt === RETRIES) throw err;
      const wait = Math.min(60000, 5000 * Math.pow(2, attempt - 1));
      console.log(`[quota] ${name}: ${err.code || err.message}`);
      console.log(`[quota] waiting ${wait} ms before retry...`);
      await sleep(wait);
    }
  }
  throw last;
}

function safeFile(name) { return name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json'; }

const manifest = {
  backupType: 'read-only-known-collections',
  createdAt: new Date().toISOString(),
  projectId: serviceAccount.project_id || null,
  collectionsRequested: COLLECTIONS,
  collections: [],
  documents: 0,
  errors: []
};

async function main() {
  console.log('');
  console.log('====================================================');
  console.log(' BUDDIES & BITES FIRESTORE BACKUP — FRESH START');
  console.log(' READ-ONLY / NO listCollections() / LOW TRAFFIC');
  console.log('====================================================');
  console.log('Firebase project:', serviceAccount.project_id || 'unknown');
  console.log('Backup directory:', backupRoot);
  console.log('');
  console.log('NO Firestore documents will be modified.');
  console.log('Render should remain SUSPENDED while this runs.');
  console.log('');

  for (let i = 0; i < COLLECTIONS.length; i++) {
    const name = COLLECTIONS[i];
    console.log('----------------------------------------------------');
    console.log(`COLLECTION ${i + 1}/${COLLECTIONS.length}: ${name}`);
    console.log('----------------------------------------------------');

    try {
      const snap = await readCollection(name);
      const documents = snap.docs.map(doc => ({
        id: doc.id,
        path: doc.ref.path,
        data: serializeValue(doc.data())
      }));

      const file = path.join(collectionsDir, safeFile(name));
      fs.writeFileSync(file, JSON.stringify({
        collection: name,
        exportedAt: new Date().toISOString(),
        documentCount: documents.length,
        documents
      }, null, 2), 'utf8');

      manifest.collections.push({ name, documentCount: documents.length, file: path.relative(backupRoot, file) });
      manifest.documents += documents.length;
      console.log(`SUCCESS: ${documents.length} document(s) saved.`);
    } catch (err) {
      console.error(`FAILED: ${name}`);
      console.error(err && err.message ? err.message : err);
      manifest.errors.push({ collection: name, code: err && err.code || null, error: err && err.message || String(err) });
    }

    if (i < COLLECTIONS.length - 1) {
      console.log(`Waiting ${DELAY_MS} ms before next collection...`);
      await sleep(DELAY_MS);
    }
  }

  const manifestFile = path.join(backupRoot, 'backup-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('');
  console.log('====================================================');
  console.log(' BACKUP FINISHED');
  console.log('====================================================');
  console.log('Collections requested:', COLLECTIONS.length);
  console.log('Collections saved:', manifest.collections.length);
  console.log('Documents saved:', manifest.documents);
  console.log('Errors:', manifest.errors.length);
  console.log('Backup folder:', backupRoot);
  console.log('Manifest:', manifestFile);
  console.log('');

  if (manifest.errors.length) {
    console.log('NOT SAFE FOR MIGRATION YET — review backup-manifest.json.');
    process.exitCode = 2;
  } else {
    console.log('BACKUP VERIFIED AT SCRIPT LEVEL: 0 COLLECTION ERRORS.');
  }
}

main().catch(err => {
  console.error('BACKUP FAILED:', err);
  process.exit(1);
});
