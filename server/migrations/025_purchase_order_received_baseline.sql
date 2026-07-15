ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_received_baseline_qty numeric;

WITH earliest_received AS (
  SELECT DISTINCT ON (line_id)
         line_id,
         received_qty
    FROM (
      SELECT
        NULLIF(details->'line'->>'line_id', '')::numeric AS line_id,
        ABS(COALESCE(NULLIF(details->'line'->>'netsuite_received_qty', '')::numeric, 0)) AS received_qty,
        created_at,
        id
      FROM delivery_audit_log
      WHERE action = 'netsuite.receiving_line.discover'
        AND COALESCE(details->'line'->>'line_id', '') ~ '^-?[0-9]+([.][0-9]+)?$'

      UNION ALL

      SELECT
        NULLIF(line_id, 0)::numeric AS line_id,
        ABS(COALESCE(NULLIF(details->'changes'->'netsuite_received_qty'->>'before', '')::numeric, 0)) AS received_qty,
        created_at,
        id
      FROM delivery_audit_log
      WHERE action = 'netsuite.receiving_line.update'
        AND line_id IS NOT NULL
        AND COALESCE(details->'changes'->'netsuite_received_qty'->>'before', '') ~ '^-?[0-9]+([.][0-9]+)?$'
    ) history
   WHERE line_id IS NOT NULL
   ORDER BY line_id, created_at, id
)
UPDATE purchase_order_lines line
   SET netsuite_received_baseline_qty = CASE
         WHEN COALESCE(line.raw->>'scmSplit', line.raw->>'scmGroup', '') <> '' THEN 0
         ELSE COALESCE(
           (SELECT history.received_qty
              FROM earliest_received history
             WHERE history.line_id = line.line_id),
           line.netsuite_received_qty,
           0
         )
       END
 WHERE line.netsuite_received_baseline_qty IS NULL;

UPDATE purchase_order_lines
   SET netsuite_received_baseline_qty = COALESCE(netsuite_received_qty, 0)
 WHERE netsuite_received_baseline_qty IS NULL;

ALTER TABLE purchase_order_lines
  ALTER COLUMN netsuite_received_baseline_qty SET DEFAULT 0,
  ALTER COLUMN netsuite_received_baseline_qty SET NOT NULL;

COMMENT ON COLUMN purchase_order_lines.netsuite_received_baseline_qty IS
  'NetSuite quantity received when the PO line first entered local tracking. Operational PO availability subtracts this fixed baseline; netsuite_received_qty remains the latest NetSuite reconciliation value.';
