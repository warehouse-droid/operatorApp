ALTER TABLE dispatch_plan_followup_outbox
  ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}'::jsonb;
