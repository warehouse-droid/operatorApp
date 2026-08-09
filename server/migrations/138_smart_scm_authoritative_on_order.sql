ALTER TABLE inventory_balances
  ADD COLUMN IF NOT EXISTS quantity_on_order numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_backordered numeric NOT NULL DEFAULT 0;

ALTER TABLE scm_smart_inventory_snapshots
  ADD COLUMN IF NOT EXISTS quantity_on_order numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_backordered numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN inventory_balances.quantity_on_order IS
  'Authoritative per-item/per-yard AggregateItemLocation.quantityonorder captured from NetSuite.';

COMMENT ON COLUMN inventory_balances.quantity_backordered IS
  'Authoritative per-item/per-yard AggregateItemLocation.quantitybackordered captured from NetSuite.';

COMMENT ON COLUMN scm_smart_inventory_snapshots.quantity_on_order IS
  'Immutable NetSuite on-order quantity captured with the Smart SCM inventory observation.';

COMMENT ON COLUMN scm_smart_inventory_snapshots.quantity_backordered IS
  'Immutable NetSuite backordered quantity captured with the Smart SCM inventory observation.';
