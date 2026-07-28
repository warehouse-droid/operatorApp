ALTER TABLE scm_print_jobs
  ADD COLUMN IF NOT EXISTS printer_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS agent_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE scm_yard_printers
  ADD COLUMN IF NOT EXISTS agent_version integer NOT NULL DEFAULT 1;

UPDATE scm_print_jobs
   SET printer_targets = COALESCE(
     (
       SELECT jsonb_agg(
         jsonb_build_object(
           'printerName', printer_name,
           'inputBin', NULL
         )
         ORDER BY ordinal
       )
         FROM jsonb_array_elements_text(printer_names) WITH ORDINALITY AS names(printer_name, ordinal)
     ),
     '[]'::jsonb
   )
 WHERE printer_targets = '[]'::jsonb
   AND jsonb_array_length(printer_names) > 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_print_jobs_printer_targets_array'
       AND conrelid = 'scm_print_jobs'::regclass
  ) THEN
    ALTER TABLE scm_print_jobs
      ADD CONSTRAINT scm_print_jobs_printer_targets_array
      CHECK (jsonb_typeof(printer_targets) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_print_jobs_agent_diagnostics_object'
       AND conrelid = 'scm_print_jobs'::regclass
  ) THEN
    ALTER TABLE scm_print_jobs
      ADD CONSTRAINT scm_print_jobs_agent_diagnostics_object
      CHECK (jsonb_typeof(agent_diagnostics) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_yard_printers_agent_version_positive'
       AND conrelid = 'scm_yard_printers'::regclass
  ) THEN
    ALTER TABLE scm_yard_printers
      ADD CONSTRAINT scm_yard_printers_agent_version_positive
      CHECK (agent_version >= 1);
  END IF;
END
$$;

COMMENT ON COLUMN scm_print_jobs.printer_targets IS
  'Windows printer destinations and optional RawKind input-bin values snapshotted when queued. A human-approved TO retry refreshes the snapshot from current routing; legacy incomplete TO snapshots are repaired before lease.';

COMMENT ON COLUMN scm_print_jobs.agent_diagnostics IS
  'Structured timing and process diagnostics reported by Windows yard printer agent v3 or later.';

COMMENT ON COLUMN scm_yard_printers.agent_version IS
  'Most recent protocol version reported while the configured Windows yard agent polled for work.';

COMMENT ON COLUMN scm_yard_printers.settings IS
  'Yard printer destinations and document routing. settings.printers supports slots 1-2, TO/SO assignments, and an optional Windows RawKind inputBin.';
