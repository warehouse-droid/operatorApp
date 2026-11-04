-- 1. Sales and SCM see when SCM last changed the Sales-visible reply on a line.
--    Existing replies use the line's last stock-check time, the best saved evidence.
-- 2. A manually linked SO was authored outside the SO draft, so a pending
--    "changed customer decisions" draft review no longer applies to that request.
ALTER TABLE sales_special_stock_lines
  ADD COLUMN IF NOT EXISTS sales_visible_note_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS sales_visible_note_updated_by text;

UPDATE sales_special_stock_lines
   SET sales_visible_note_updated_at = responded_at,
       sales_visible_note_updated_by = responded_by
 WHERE sales_visible_note_updated_at IS NULL
   AND btrim(COALESCE(sales_visible_note, '')) <> ''
   AND responded_at IS NOT NULL;

UPDATE sales_special_stock_cases
   SET line_edit_state = line_edit_state - 'orderReviewRequired'
 WHERE sales_order_source = 'manual_link'
   AND sales_order_netsuite_id IS NOT NULL
   AND line_edit_state ? 'orderReviewRequired';
