-- Preserve standalone Machine Master identity independently of Vehicle Master IDs.
CREATE UNIQUE INDEX repair_vehicles_standalone_machine_unique ON repair_vehicles(machine_id)
 WHERE netsuite_id IS NULL;

-- Verified Vehicle Master owner: 000033 Mr Bin Building Supply LTD.
-- Only fill an unconfigured directory owner; preserve administrator choices.
UPDATE repair_settings SET data=jsonb_set(data,'{mappings,mbbsCustomerId}','"7143"'::jsonb),
 revision=revision+1,updated_by='repair_master_directory',updated_at=now()
 WHERE coalesce(data->'mappings'->>'mbbsCustomerId','')='';
