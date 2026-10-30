-- Correct the comparison without changing saved counts, snapshots or adjustments.
UPDATE inventory_count_sheet_counts
SET variance = quantity - actual_on_hand + adjusting
WHERE actual_on_hand IS NOT NULL;
