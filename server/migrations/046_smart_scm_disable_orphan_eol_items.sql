-- Finish the cleanup for legacy planning policies whose NetSuite inventory item
-- no longer exists. Prefer the current canonical description when available;
-- otherwise use the retained Item Master policy description.
UPDATE scm_smart_item_policies AS policy
   SET planning_enabled = false,
       updated_by = 'system:eol-description-migration',
       updated_at = now()
 WHERE policy.planning_enabled = true
   AND COALESCE(
         (
           SELECT NULLIF(BTRIM(item.item_description), '')
             FROM inventory_items AS item
            WHERE item.item_id = policy.item_id
         ),
         policy.item_description,
         ''
       ) ~* '(^|[^[:alnum:]_])EOL([^[:alnum:]_]|$)|WHILE[[:space:]]+QTY[[:space:]]+LAST';
