-- A receipt arriving during a leased read needs one additional authoritative read.
ALTER TABLE netsuite_delayed_status_refresh_jobs
  ADD COLUMN IF NOT EXISTS receipt_refresh_requested boolean NOT NULL DEFAULT false;
