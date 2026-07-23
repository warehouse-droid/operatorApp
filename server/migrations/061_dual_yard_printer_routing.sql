ALTER TABLE scm_print_jobs
  ADD COLUMN IF NOT EXISTS printer_names jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE scm_print_jobs job
   SET printer_names = CASE
     WHEN trim(COALESCE(printer.printer_name, '')) <> ''
       THEN jsonb_build_array(printer.printer_name)
     ELSE '[]'::jsonb
   END
  FROM scm_yard_printers printer
 WHERE printer.location_id = job.location_id
   AND job.printer_names = '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scm_print_jobs_printer_names_array'
       AND conrelid = 'scm_print_jobs'::regclass
  ) THEN
    ALTER TABLE scm_print_jobs
      ADD CONSTRAINT scm_print_jobs_printer_names_array
      CHECK (jsonb_typeof(printer_names) = 'array');
  END IF;
END
$$;

COMMENT ON COLUMN scm_print_jobs.printer_names IS
  'Immutable Windows printer destinations selected when the job is queued. TO jobs contain two names; SO jobs contain one.';

COMMENT ON COLUMN scm_yard_printers.settings IS
  'Yard printer destinations and document routing. settings.printers supports slots 1-2 with TO/SO assignments.';
