// These aliases are supplied only by repository SQL, never by request values.
// The baseline predates local tracking; current NetSuite and local receipts overlap.
export function smartScmSplitRemainingSql(line = "child_line", po = "child_po") {
  const physical = [
    ["received_pallet_qty", "to_plt"], ["received_layer_qty", "to_lyr"],
    ["received_section_qty", "to_sec"], ["received_piece_qty", "to_pcs"]
  ].map(([quantity, conversion]) =>
    `(GREATEST(COALESCE(${line}.${quantity}, 0), 0) * GREATEST(COALESCE(${line}.${conversion}, 0), 0))`
  ).join(" + ");
  return `CASE
    WHEN lower(btrim(COALESCE(${po}.receipt_status, ''))) = 'received'
      OR EXISTS (
        SELECT 1 FROM dispatch_order_completion_status completion
         WHERE completion.order_kind = 'PO'
           AND completion.dispatch_completion_status = 'completed'
           AND lower(btrim(completion.order_ref)) = lower(btrim(split.split_po_ref))
      ) THEN 0
    ELSE GREATEST(COALESCE(${line}.quantity, 0) - GREATEST(
      COALESCE(${line}.netsuite_received_qty, 0),
      GREATEST(COALESCE(${line}.netsuite_received_baseline_qty, 0), 0)
        + CASE WHEN ${line}.confirmed_at IS NOT NULL
                 AND ${line}.confirmed_at <= ${po}.received_at
                 AND lower(btrim(COALESCE(${po}.receipt_status, ''))) = 'partial_received'
          THEN GREATEST(COALESCE(${line}.received_sales_qty, 0), ${physical}, 0)
          ELSE 0 END,
      0
    ), 0)
  END`;
}
