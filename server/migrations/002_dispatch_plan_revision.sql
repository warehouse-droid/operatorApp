ALTER TABLE dispatch_plans
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;
