CREATE TABLE IF NOT EXISTS hungerbay_sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_name TEXT NOT NULL,
    document_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status
ON hungerbay_sync_queue(status);

CREATE TABLE IF NOT EXISTS hungerbay_sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    collection_name TEXT,
    document_id TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hungerbay_orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    order_data TEXT NOT NULL,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hungerbay_products (
    id TEXT PRIMARY KEY,
    product_data TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hungerbay_customers (
    id TEXT PRIMARY KEY,
    customer_data TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hungerbay_inventory (
    id TEXT PRIMARY KEY,
    inventory_data TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);