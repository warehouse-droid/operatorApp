const hasIdentity=line=>/^(?:DMG:|C:)|\[Damage report /.test(String(line.description || ''));
const hasLine=report=>report.transfer_line!==null && report.transfer_line!==undefined;
function matchesValues(line,report) {
  const quantity=Number(report.quantity),lineQuantity=Number(line.adjustQtyBy);
  return Number.isSafeInteger(Number(line.line)) && Number(line.line)>0
    && Number(report.item_id)>0 && String(line.item?.id)===String(report.item_id)
    && Number.isFinite(quantity) && quantity>0 && Number.isFinite(lineQuantity) && Math.abs(lineQuantity-quantity)<=1e-6
    && Number(report.unit_id)>0 && String(line.units)===String(report.unit_id)
    && Number(report.reason_id)>0 && String(line.custcol_atlas_rc_so?.id)===String(report.reason_id);
}
// This links evidence for display only; it never confirms or retries a stock write.
export function recoverDamagePhotoLines(transfers,reports) {
  const recovered=new Map();
  for(const transfer of transfers) {
    const local=reports.filter(report=>!report.legacy && String(report.transfer_id)===String(transfer.id));
    const unclaimed=(transfer.inventory?.items || []).filter(line=>!hasIdentity(line)
      && !local.some(report=>hasLine(report) && Number(report.transfer_line)===Number(line.line)));
    for(const report of local) {
      if(report.status!=='attention' || report.safe_to_retry!==false || hasLine(report)) {continue;}
      const lines=unclaimed.filter(line=>matchesValues(line,report));
      if(lines.length!==1) {continue;}
      const competing=local.filter(other=>!hasLine(other) && matchesValues(lines[0],other));
      if(competing.length===1) {recovered.set(report.id,{transferId:String(transfer.id),line:Number(lines[0].line)});}
    }
  }
  return recovered;
}
