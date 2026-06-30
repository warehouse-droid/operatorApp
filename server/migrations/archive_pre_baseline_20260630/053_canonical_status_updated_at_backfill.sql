UPDATE sales_orders
   SET status_updated_at = COALESCE(status_updated_at, synced_at, now())
 WHERE status_updated_at IS NULL;

UPDATE transfer_orders
   SET status_updated_at = COALESCE(status_updated_at, synced_at, now())
 WHERE status_updated_at IS NULL;

UPDATE purchase_orders
   SET status_updated_at = COALESCE(status_updated_at, synced_at, now())
 WHERE status_updated_at IS NULL;

UPDATE co_orders
   SET status_updated_at = COALESCE(status_updated_at, updated_at, created_at, now())
 WHERE status_updated_at IS NULL;
