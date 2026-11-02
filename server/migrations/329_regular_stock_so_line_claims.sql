-- Delivery requests claim individual SO lines, not whole SOs. A Sales Order may
-- now hold several regular stock handoffs: one per batch of selected lines.
DROP INDEX IF EXISTS regular_stock_handoffs_sales_order_unique;
DROP INDEX IF EXISTS regular_stock_handoffs_sales_ref_unique;
CREATE INDEX IF NOT EXISTS regular_stock_handoffs_sales_order
  ON regular_stock_handoffs(sales_order_id);
CREATE INDEX IF NOT EXISTS regular_stock_handoffs_sales_ref
  ON regular_stock_handoffs(upper(btrim(sales_order_ref)));

-- A line claim is released, never deleted, when its TO is closed or cancelled,
-- its request is rejected, or the SO line now holds a different item. History
-- stays on the released row; at most one claim per SO line remains active.
ALTER TABLE regular_stock_so_line_owners
  ADD COLUMN IF NOT EXISTS item_id bigint,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by_request_id bigint REFERENCES sales_stock_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS release_evidence jsonb;
-- Existing claims keep an unknown claim time; new claims record theirs.
ALTER TABLE regular_stock_so_line_owners ALTER COLUMN claimed_at SET DEFAULT now();
ALTER TABLE regular_stock_so_line_owners DROP CONSTRAINT IF EXISTS regular_stock_so_line_owners_pkey;
ALTER TABLE regular_stock_so_line_owners ADD PRIMARY KEY (sales_order_id, remote_line_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS regular_stock_so_line_owners_active
  ON regular_stock_so_line_owners(sales_order_id, remote_line_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS regular_stock_so_line_owners_request
  ON regular_stock_so_line_owners(request_id);
ALTER TABLE regular_stock_so_line_owners DROP CONSTRAINT IF EXISTS regular_stock_so_line_owners_release_check;
ALTER TABLE regular_stock_so_line_owners ADD CONSTRAINT regular_stock_so_line_owners_release_check
  CHECK ((released_at IS NULL) = (release_evidence IS NULL));

-- Record the item each existing claim was made for, from its saved SO snapshot.
UPDATE regular_stock_so_line_owners o
   SET item_id = claimed.item_id
  FROM (
    SELECT h.request_id, (line.value->>'remoteLineId')::bigint AS remote_line_id,
           min((line.value->>'itemId')::bigint) AS item_id
      FROM regular_stock_handoffs h
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(h.plan->'order'->'lines','[]'::jsonb)) line
     WHERE (line.value->>'remoteLineId') ~ '^[0-9]+$' AND (line.value->>'itemId') ~ '^[0-9]+$'
     GROUP BY h.request_id, (line.value->>'remoteLineId')::bigint
  ) claimed
 WHERE o.item_id IS NULL AND claimed.request_id = o.request_id AND claimed.remote_line_id = o.remote_line_id;
