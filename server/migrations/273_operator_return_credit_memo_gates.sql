-- New confirmations may choose direct Credit Memos. Existing immutable batch
-- intents retain Return Authorization behavior even after these gates change.
INSERT INTO mbt_feature_flags(flag_key, enabled, description)
SELECT 'operator_netsuite_' || kind || '_return_cm_' || yard, false,
       'Create a Credit Memo directly on Operator ' || kind || ' return confirmation at ' || yard ||
       '. Takes priority over its RA gate; enable both CM gates for combined returns.'
FROM unnest(ARRAY['stock','pallet']) AS kind
CROSS JOIN unnest(ARRAY['3445','2967','12441','150']) AS yard
ON CONFLICT (flag_key) DO NOTHING;
