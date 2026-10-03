CREATE TABLE IF NOT EXISTS sales_special_stock_document_cache (
  request_id bigint NOT NULL REFERENCES sales_special_stock_cases(request_id) ON DELETE CASCADE,
  order_kind text NOT NULL CHECK (order_kind IN ('sales_order', 'purchase_order')),
  audience text NOT NULL CHECK (audience IN ('sales', 'scm')),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  filename text NOT NULL,
  pdf bytea NOT NULL CHECK (octet_length(pdf) BETWEEN 5 AND 15728640),
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, order_kind, audience)
);
