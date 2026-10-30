ALTER TABLE inventory_count_sheet_counts
  ADD COLUMN adjusting numeric NOT NULL DEFAULT 0
  CHECK (adjusting BETWEEN -1000000000000 AND 1000000000000
    AND adjusting = round(adjusting, 6));

-- Preserve the count and its stock snapshot; change only the review comparison.
UPDATE inventory_count_sheet_counts
SET variance = actual_on_hand - quantity + adjusting
WHERE actual_on_hand IS NOT NULL;
