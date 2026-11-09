-- CPU, memory and database activity, sampled by the app every 30 s and kept 14 days
-- (src/system-resource-monitor.js). Admin -> Audit Log charts it beside the audit events.
CREATE TABLE IF NOT EXISTS system_resource_samples (
  id bigserial PRIMARY KEY,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  process_name text NOT NULL DEFAULT 'app',
  interval_ms integer NOT NULL,
  host_cpu_percent real,
  host_cpu_cores smallint,
  host_load_1m real,
  host_memory_total_mb integer,
  host_memory_available_mb integer,
  -- Share of the whole host, the same scale as host_cpu_percent.
  app_cpu_percent real,
  app_memory_mb integer,
  app_heap_mb integer,
  event_loop_max_ms real,
  event_loop_p99_ms real,
  db_connections integer,
  db_active_queries integer,
  db_waiting_queries integer,
  db_parallel_workers integer,
  db_longest_query_seconds integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT system_resource_samples_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_system_resource_samples_sampled
  ON system_resource_samples (sampled_at DESC);
