-- Admin -> Performance (src/performance-stats.js, src/request-timing.js).
-- Server-side load time of every page and API call, per 5 minutes, kept 14 days.
-- Admin -> Performance reads percentiles from the summed histograms.
CREATE TABLE IF NOT EXISTS system_request_timings (
  bucket_at timestamptz NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  -- Calling page from the Referer ('' when unknown); the page itself for HTML page requests.
  page text NOT NULL DEFAULT '',
  status_class text NOT NULL,
  count integer NOT NULL,
  total_ms bigint NOT NULL,
  max_ms integer NOT NULL,
  -- Counts per duration bucket; upper edges in ms: 100, 250, 500, 1000, 2000, 3000, 5000, 10000,
  -- 20000, 30000, 60000, then everything slower.
  buckets integer[] NOT NULL,
  CONSTRAINT system_request_timings_status_class CHECK (status_class IN ('1xx', '2xx', '3xx', '4xx', '5xx', 'aborted')),
  CONSTRAINT system_request_timings_count CHECK (count > 0),
  CONSTRAINT system_request_timings_key UNIQUE (bucket_at, method, route, page, status_class)
);

CREATE INDEX IF NOT EXISTS idx_system_request_timings_route
  ON system_request_timings (route, bucket_at);

-- Driver completion: offline job completions by the time the server received them.
CREATE INDEX IF NOT EXISTS idx_driver_offline_events_completed_received
  ON driver_offline_events (server_received_at)
  WHERE event_type = 'job_completed';

-- PO and SO auto-fulfillment NetSuite times: NetSuite writes by action and time.
CREATE INDEX IF NOT EXISTS idx_system_audit_events_netsuite_action
  ON system_audit_events (action, occurred_at)
  WHERE category = 'netsuite';
