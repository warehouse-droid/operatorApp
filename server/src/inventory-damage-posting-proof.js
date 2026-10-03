import {inventoryError} from './inventory-workflow-domain.js';

export function damageLineSnapshot(line) {
  return {line:Number(line.line),item:String(line.item?.id),quantity:Number(line.adjustQtyBy),
    unit:String(line.units),reason:String(line.custcol_atlas_rc_so?.id || '')};
}
export function damagePostingProof(report,record,memo) {
  return {version:1,reportId:report.id,transferId:record?String(record.id):null,externalId:report.external_id,
    memo,lines:(record?.inventory?.items || []).map(damageLineSnapshot)};
}
export function damageReceiptMemo(memo,reportId,kind='DMG') {
  const prefix=String(memo || '').replace(/ \[(?:DMG|C):[0-9a-f-]{36}\]$/i,'');
  return `${prefix} [${kind}:${reportId}]`;
}
export function damageLineMatches(line,report) {
  const current=damageLineSnapshot(line);
  return Number.isSafeInteger(current.line) && current.line>0 && current.item===String(report.item_id)
    && Number.isFinite(current.quantity) && current.quantity>0 && Math.abs(current.quantity-Number(report.quantity))<=1e-6
    && current.unit===String(report.unit_id) && current.reason===String(report.reason_id);
}
export function confirmedDamageProofLine(record,report,proof) {
  if(proof?.version!==1 || proof.reportId!==report.id || record.memo!==proof.memo
    || !String(record.memo).endsWith(` [DMG:${report.id}]`)) {return null;}
  if(proof.transferId?String(record.id)!==proof.transferId:record.externalId!==proof.externalId) {return null;}
  const lines=record.inventory?.items;
  if(!Array.isArray(lines) || record.inventory.hasMore || Number(record.inventory.totalResults ?? lines.length)!==lines.length) {
    throw inventoryError('Could not read the complete transfer. Recheck posting before retrying.',409);
  }
  const prior=new Map(proof.lines.map(line=>[line.line,line]));
  if(prior.size!==proof.lines.length || lines.length!==prior.size+1
    || new Set(lines.map(line=>Number(line.line))).size!==lines.length) {return null;}
  const added=[];
  for(const line of lines) {
    const snapshot=damageLineSnapshot(line),before=prior.get(snapshot.line);
    if(before) {
      if(Object.keys(snapshot).some(key=>snapshot[key]!==before[key])) {return null;}
      prior.delete(snapshot.line);
    } else {added.push(line);}
  }
  if(prior.size || added.length!==1 || !damageLineMatches(added[0],report)
    || /^(?:DMG:|C:)|\[Damage report /.test(String(added[0].description || ''))) {return null;}
  return added[0];
}
