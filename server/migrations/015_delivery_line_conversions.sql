ALTER TABLE delivery_order_lines
  ADD COLUMN IF NOT EXISTS to_plt numeric,
  ADD COLUMN IF NOT EXISTS to_lyr numeric,
  ADD COLUMN IF NOT EXISTS to_sec numeric,
  ADD COLUMN IF NOT EXISTS to_pcs numeric;

UPDATE delivery_order_lines l
SET to_plt = COALESCE(l.to_plt, i.to_plt),
    to_lyr = COALESCE(l.to_lyr, i.to_lyr),
    to_sec = COALESCE(l.to_sec, i.to_sec),
    to_pcs = COALESCE(l.to_pcs, i.to_pcs)
FROM inventory_items i
WHERE i.item_id = l.item_id;
