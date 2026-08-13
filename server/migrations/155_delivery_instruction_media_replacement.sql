-- A replacement upload is registered atomically: the existing media remains
-- active until its uploaded successor is validated and committed, and the new
-- object inherits the existing gallery position.

ALTER TABLE sales_order_delivery_instruction_upload_tickets
  ADD COLUMN IF NOT EXISTS replacement_media_id uuid
    REFERENCES sales_order_delivery_instruction_media(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_order_delivery_instruction_tickets_replacement
  ON sales_order_delivery_instruction_upload_tickets (replacement_media_id, expires_at)
  WHERE consumed_at IS NULL AND replacement_media_id IS NOT NULL;
