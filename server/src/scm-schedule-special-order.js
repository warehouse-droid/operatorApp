// Project request links onto the visible PO identity, including local splits
// and groups. Keep this derived so linking/unlinking a request takes effect on
// the next schedule read without changing the PO or its NetSuite memo.
export const SCM_SCHEDULE_SPECIAL_ORDER_CTES = `
    po_schedule_sources AS (
      SELECT source_id AS schedule_po_id, source_id AS po_id FROM base_po
      UNION
      SELECT schedule.source_id, member_po.netsuite_id
        FROM base_po schedule
        JOIN scm_schedule_groups groups
          ON lower(groups.group_ref) = lower(schedule.order_ref)
         AND groups.status = 'active'
        JOIN scm_schedule_group_members member
          ON member.group_id = groups.id AND member.order_kind = 'PO'
        JOIN purchase_orders member_po
          ON lower(member.order_ref) = lower(COALESCE(NULLIF(member_po.dispatch_ref, ''), member_po.tranid))
    ),
    po_request_sources AS (
      SELECT schedule_po_id, po_id FROM po_schedule_sources
      UNION
      SELECT source.schedule_po_id, split.source_po_id
        FROM po_schedule_sources source
        JOIN dispatch_scm_po_splits split
          ON split.split_po_id = source.po_id AND split.status = 'active'
    ),
    po_special_items AS (
      SELECT DISTINCT source.schedule_po_id
        FROM po_schedule_sources source
        JOIN purchase_order_lines line ON line.purchase_order_id = source.po_id
       WHERE line.netsuite_active = true
         AND (line.item_id = 2055
           OR lower(btrim(line.item_name)) = 'mbbs-special order'
           OR lower(btrim(line.sku)) = 'mbbs-special order')
    ),
    po_special_requests AS (
      SELECT source.schedule_po_id,
             'For ' || string_agg(DISTINCT NULLIF(upper(btrim(special.sales_order_ref)), ''), ', '
               ORDER BY NULLIF(upper(btrim(special.sales_order_ref)), '')) AS remark_prefix
        FROM po_request_sources source
        JOIN sales_special_stock_cases special
          ON special.purchase_order_netsuite_id = source.po_id
         AND special.workflow_kind = 'special'
       GROUP BY source.schedule_po_id
    ),
`;
