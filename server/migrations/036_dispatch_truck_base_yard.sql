ALTER TABLE dispatch_trucks
  ADD COLUMN IF NOT EXISTS base_yard text NOT NULL DEFAULT '';

