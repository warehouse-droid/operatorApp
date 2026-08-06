ALTER TABLE dispatch_plan_commands
  ALTER COLUMN actor_id TYPE text USING actor_id::text;
