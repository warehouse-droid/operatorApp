ALTER TABLE scm_reconciliation_settings
  ADD COLUMN aggregate_nightly_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN aggregate_nightly_time text NOT NULL DEFAULT '21:30'
    CHECK (aggregate_nightly_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE scm_reconciliation_runs
  ADD COLUMN source_filter text NOT NULL DEFAULT ''
    CHECK (source_filter IN ('', 'pending_fulfillment_aggregate')),
  ADD COLUMN scheduled_local_date date,
  ADD CONSTRAINT scm_reconciliation_aggregate_scope
    CHECK (source_filter <> 'pending_fulfillment_aggregate' OR scope_kind = 'SO');

CREATE UNIQUE INDEX scm_reconciliation_aggregate_nightly_date
  ON scm_reconciliation_runs (source_filter, scheduled_local_date)
  WHERE source_filter = 'pending_fulfillment_aggregate'
    AND trigger_source = 'nightly';
