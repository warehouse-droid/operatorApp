CREATE TABLE stock_request_conversation_reads (
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  read_event_id bigint NOT NULL CHECK (read_event_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, operator_id)
);
CREATE INDEX stock_request_conversation_events_idx
  ON sales_stock_request_events (request_id, id DESC)
  WHERE event_type = 'stock_request_conversation_message';
