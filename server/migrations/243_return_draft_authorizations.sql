ALTER TABLE return_batch_authorizations
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES return_drafts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS staged_records jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='return_batch_draft_staging_paired') THEN
    ALTER TABLE return_batch_authorizations ADD CONSTRAINT return_batch_draft_staging_paired
      CHECK ((draft_id IS NULL) = (staged_records IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS return_batch_authorization_draft
  ON return_batch_authorizations(draft_id) WHERE draft_id IS NOT NULL;
