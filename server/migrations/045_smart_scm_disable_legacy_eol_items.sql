-- Complete the one-time cleanup for legacy Item Master rows whose current
-- inventory description is blank but whose retained policy description carries
-- an end-of-life/last-quantity marker.
UPDATE scm_smart_item_policies AS policy
   SET planning_enabled = false,
       updated_by = 'system:eol-description-migration',
       updated_at = now()
  FROM inventory_items AS item
 WHERE item.item_id = policy.item_id
   AND policy.planning_enabled = true
   AND COALESCE(
         NULLIF(BTRIM(item.item_description), ''),
         policy.item_description,
         ''
       ) ~* '(^|[^[:alnum:]_])EOL([^[:alnum:]_]|$)|WHILE[[:space:]]+QTY[[:space:]]+LAST';
