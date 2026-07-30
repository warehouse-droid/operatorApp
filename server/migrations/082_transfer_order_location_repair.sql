-- Inbound and outbound NetSuite searches do not always expose both sides of a
-- Transfer Order. Repair only missing header locations when the active mirror
-- lines agree on exactly one location; never guess across mixed locations.

WITH unique_line_locations AS (
  SELECT line.transfer_order_id,
         CASE
           WHEN COUNT(DISTINCT line.location_id) FILTER (
             WHERE line.line_stage = 'outbound'
               AND line.location_id IS NOT NULL
           ) = 1
           THEN MIN(line.location_id) FILTER (
             WHERE line.line_stage = 'outbound'
               AND line.location_id IS NOT NULL
           )
           ELSE NULL
         END AS from_location_id,
         CASE
           WHEN COUNT(DISTINCT line.location_id) FILTER (
             WHERE line.line_stage = 'outbound'
               AND line.location_id IS NOT NULL
           ) = 1
           THEN MAX(NULLIF(BTRIM(line.location), '')) FILTER (
             WHERE line.line_stage = 'outbound'
               AND line.location_id IS NOT NULL
           )
           ELSE NULL
         END AS from_location,
         CASE
           WHEN COUNT(DISTINCT line.location_id) FILTER (
             WHERE line.line_stage = 'receiving'
               AND line.location_id IS NOT NULL
           ) = 1
           THEN MIN(line.location_id) FILTER (
             WHERE line.line_stage = 'receiving'
               AND line.location_id IS NOT NULL
           )
           ELSE NULL
         END AS to_location_id,
         CASE
           WHEN COUNT(DISTINCT line.location_id) FILTER (
             WHERE line.line_stage = 'receiving'
               AND line.location_id IS NOT NULL
           ) = 1
           THEN MAX(NULLIF(BTRIM(line.location), '')) FILTER (
             WHERE line.line_stage = 'receiving'
               AND line.location_id IS NOT NULL
           )
           ELSE NULL
         END AS to_location
    FROM transfer_order_lines line
   WHERE line.netsuite_active = true
     AND line.line_stage IN ('outbound', 'receiving')
   GROUP BY line.transfer_order_id
)
UPDATE transfer_orders transfer
   SET from_location_id = COALESCE(transfer.from_location_id, inferred.from_location_id),
       from_location = COALESCE(NULLIF(BTRIM(transfer.from_location), ''), inferred.from_location),
       to_location_id = COALESCE(transfer.to_location_id, inferred.to_location_id),
       to_location = COALESCE(NULLIF(BTRIM(transfer.to_location), ''), inferred.to_location),
       status_updated_at = now()
  FROM unique_line_locations inferred
 WHERE inferred.transfer_order_id = transfer.netsuite_id
   AND (
     (transfer.from_location_id IS NULL AND inferred.from_location_id IS NOT NULL)
     OR (NULLIF(BTRIM(transfer.from_location), '') IS NULL AND inferred.from_location IS NOT NULL)
     OR (transfer.to_location_id IS NULL AND inferred.to_location_id IS NOT NULL)
     OR (NULLIF(BTRIM(transfer.to_location), '') IS NULL AND inferred.to_location IS NOT NULL)
   );
