-- One-time Item Master cleanup: discontinued/last-quantity descriptions must not
-- participate in Smart SCM planning. Yard policies are retained so an authorized
-- user can deliberately re-enable an item later without rebuilding its setup.
UPDATE scm_smart_item_policies AS policy
   SET planning_enabled = false,
       updated_by = 'system:eol-description-migration',
       updated_at = now()
  FROM inventory_items AS item
 WHERE item.item_id = policy.item_id
   AND policy.planning_enabled = true
   AND COALESCE(item.item_description, policy.item_description, '') ~*
       '(^|[^[:alnum:]_])EOL([^[:alnum:]_]|$)|WHILE[[:space:]]+QTY[[:space:]]+LAST';
