ALTER TABLE scm_schedule_user_preferences
  ADD COLUMN IF NOT EXISTS order_kinds text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS methods text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS dropoff_points text[] NOT NULL DEFAULT '{}'::text[];

-- Preserve existing single selections when upgrading.
UPDATE scm_schedule_user_preferences
   SET order_kinds = ARRAY[order_kind]
 WHERE cardinality(order_kinds) = 0 AND order_kind <> '';

UPDATE scm_schedule_user_preferences
   SET methods = ARRAY[method]
 WHERE cardinality(methods) = 0 AND method <> '';
