import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { getSmartScmProposal } from "./smart-scm-planning-repository.js";
import { smartScmLineKey, smartScmOrderedLines, validateSmartScmLineOrder } from "./smart-scm-line-order.js";

export async function saveSmartScmProposalLineOrder(proposalId, values = {}, operatorId = null) {
  return withTransaction(async () => {
    const locked = await query("SELECT * FROM scm_smart_proposals WHERE id = $1 FOR UPDATE", [Number(proposalId)]);
    if (!locked.rowCount) throw Object.assign(new Error("Smart SCM proposal was not found."), { status: 404 });
    const row = locked.rows[0];
    const editable = ["draft", "held", "reviewed", "attention", "order_requested", "vendor_replied"].includes(row.status)
      || (row.status === "confirmed" && row.vendor_resolution_kind === "netsuite_po_review");
    if (!editable || row.netsuite_purchase_order_id || row.netsuite_purchase_order_ref
      || row.netsuite_transfer_order_id || row.netsuite_transfer_order_ref) {
      throw Object.assign(new Error("This load is locked; its line order cannot be changed."), { status: 409 });
    }
    const proposal = await getSmartScmProposal(proposalId);
    const lines = [...proposal.lines, ...proposal.physicalPalletLines];
    const lineOrder = validateSmartScmLineOrder(values.lineOrder, lines);
    const previousOrder = smartScmOrderedLines(lines, proposal.lineOrder).map(smartScmLineKey);
    if (!Array.isArray(values.expectedLineOrder)
      || JSON.stringify(values.expectedLineOrder) !== JSON.stringify(previousOrder)) {
      throw Object.assign(new Error("The load's line order changed. Reload it and try again."), { status: 409 });
    }
    await query("UPDATE scm_smart_proposals SET line_order = $2::jsonb, updated_at = now() WHERE id = $1",
      [Number(proposalId), JSON.stringify(lineOrder)]);
    await writeAudit({ actorOperatorId: operatorId, source: "smart_scm", action: "scm.smart.proposal.line-order",
      details: { proposalId: Number(proposalId), previousOrder, lineOrder } });
    return getSmartScmProposal(proposalId);
  });
}
