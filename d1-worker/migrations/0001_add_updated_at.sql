-- Adds a server-maintained timestamp used by the website's polling-based
-- replacement for Firestore onSnapshot(). Existing records retain their
-- original created_at value as their initial updated_at value.

ALTER TABLE firestore_documents ADD COLUMN updated_at TEXT;

UPDATE firestore_documents
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_firestore_documents_collection_updated
ON firestore_documents(collection_name, updated_at);
