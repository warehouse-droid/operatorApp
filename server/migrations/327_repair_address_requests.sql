ALTER TABLE repair_requests ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE repair_requests ADD CONSTRAINT repair_requests_target_check CHECK (
 (coalesce(data->>'repairType','equipment')='equipment' AND vehicle_id IS NOT NULL)
 OR (data->>'repairType'='other' AND vehicle_id IS NULL
     AND jsonb_typeof(data->'address')='object'
     AND coalesce(length(btrim(data->'address'->>'label')),0) BETWEEN 1 AND 500)
);
