ALTER TABLE dispatch_drivers
  ADD COLUMN IF NOT EXISTS samsara_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN dispatch_drivers.samsara_enabled IS
  'Per-driver opt-in for Driver PWA DVIR, vehicle assignment, duty-status writes, and primary/secondary account handoff. Read-only fleet GPS verification remains enabled.';
