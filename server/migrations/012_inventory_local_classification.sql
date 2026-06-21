ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS classification_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS classification_updated_by text REFERENCES operators(id) ON DELETE SET NULL;

UPDATE inventory_items
SET product_type = null,
    brand = null,
    series = null,
    classification_updated_at = null,
    classification_updated_by = null;
