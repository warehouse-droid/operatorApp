// Reviewed maintenance proof. No posting capability. Original queue payloads stay immutable.
import assert from 'node:assert/strict';
import {verifyOperatorNetSuitePostingRecord} from '../../src/operator-netsuite-posting-adapter.js';
const same=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(Number(a)-Number(b))<=0.000001;
const factor=l=>l.unit_id?Number(l.conversion_rate):1;
const quantity=l=>Math.abs(Number(l.quantity))/factor(l);
const one=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0];};

export function reviewExistingIf(input,lines,localOrders) {
  const {step,record}=input;
  assert.ok(record);assert.equal(step.sourceOrderKind,'SO');assert.equal(step.transactionType,'IF');
  const reviewed=structuredClone(step),adjustments=[];
  reviewed.lineSnapshot ||= [];
  const requested=step.payload.item.items.filter(x=>x.itemReceive!==false&&Number(x.quantity)>0);
  const actual=record.item.items.filter(x=>x.itemReceive!==false&&Number(x.quantity)>0);
  const local=one(localOrders.filter(o=>Number(o.netsuite_id)===Number(step.sourceNetSuiteId)),'Unique local source');
  for(const item of actual) {
    const source=one(lines.filter(l=>Number(l.source_id)===Number(step.sourceNetSuiteId)&&Number(l.order_line)===Number(item.orderLine)),'Unique NetSuite source line');
    assert.equal(String(item.item.id),String(source.item_id));assert.equal(String(item.units??''),String(source.unit_id??''));
    assert.equal(Number(item.location?.id??item.location),Number(source.location_id));
    assert.ok(Number.isFinite(factor(source))&&factor(source)>0);
    assert.ok(Number(item.quantity)<=quantity(source)+0.000001);
    assert.ok(Number(source.fulfilled_quantity)/factor(source)+0.000001>=Number(item.quantity));
    reviewed.lineSnapshot.push({orderLine:Number(item.orderLine),itemId:Number(source.item_id)});
    const expected=requested.find(x=>Number(x.orderLine)===Number(item.orderLine));
    if(expected) {assert.ok(same(expected.quantity,item.quantity),'Requested quantity must match the saved IF');continue;}
    assert.ok(same(item.quantity,quantity(source)),'Extra line must match the full source quantity');
    let evidence;
    if(source.item_type==='NonInvtPart'&&Number(source.item_id)===4646) {
      assert.equal(source.item_name,'Sales Credit - Hardscaping');evidence={kind:'source_billing_line'};
    } else {
      const matched=one((local.lines||[]).filter(l=>String(l.lineId)===String(source.source_line_key)),'Extra line stable local identity');
      assert.equal(Number(matched.itemId),Number(source.item_id));assert.equal(Number(matched.location),Number(source.location_id));
      assert.equal(String(matched.unit||'').toUpperCase(),String(source.unit||'').toUpperCase());
      if(source.item_type==='NonInvtPart'&&Number(source.item_id)===2055) {
        assert.ok(Number(matched.loaded||0)+Number(matched.packed||0)+0.000001>=Number(item.quantity),'Saved special-order physical evidence');
        evidence={kind:'source_special_order_with_local_progress',localLineId:matched.id};
      } else {
        assert.equal(source.item_type,'InvtPart');
        const loads=(local.loads||[]).filter(r=>(r.lines||[]).some(l=>String(l.lineId)===String(source.source_line_key)
          &&Number(l.itemId)===Number(source.item_id)&&same(l.loadedQty,item.quantity)
          &&String(l.loadedUom||l.unit||'').toUpperCase()===String(source.unit||'').toUpperCase()));
        const load=one(loads,'Extra inventory requires a matching immutable earlier load');
        assert.ok(new Date(load.createdAt)<new Date(record.createdDate));
        assert.ok(Number(matched.loaded)+0.000001>=Number(item.quantity));
        evidence={kind:'previous_immutable_operator_load',operatorLoadRecordId:load.id,localLineId:matched.id};
      }
    }
    adjustments.push({...evidence,orderLine:Number(item.orderLine),sourceLineKey:String(source.source_line_key),quantity:Number(item.quantity)});
    reviewed.payload.item.items.push({orderLine:Number(item.orderLine),quantity:Number(item.quantity),itemReceive:true,location:Number(source.location_id)});
  }
  const verified=verifyOperatorNetSuitePostingRecord(reviewed,{...record,transactionType:'IF'});
  return {verified,adjustments};
}

export function reviewTransfer(job,header,lines,linked) {
  assert.equal(header.type,'TrnfrOrd');assert.equal(header.tranid,job.order_ref);
  assert.ok((job.transaction_type==='IR'?['G']:['F','G']).includes(header.status));
  const source=lines.filter(l=>Number(l.source_id)===Number(job.local_to_id));
  const transactions=new Map(),proof=[];
  for(const saved of job.snapshot.lines) {
    const anchor=one(source.filter(l=>String(l.source_line_key)===String(saved.sourceLineKey)),'Stable TO source key');
    assert.equal(Number(anchor.item_id),Number(saved.itemId));assert.ok(same(quantity(anchor),saved.quantity));
    const outbound=job.transaction_type==='IF';
    // NetSuite has a visible anchor plus distinct hidden outbound/receipt lines.
    const current=one(source.filter(l=>l.do_not_print_line==='T'&&(Number(l.quantity)<0)===outbound
      &&Number(l.item_id)===Number(anchor.item_id)&&same(quantity(l),quantity(anchor))
      &&String(l.unit_id??'')===String(anchor.unit_id??'')),'Unique directional TO line');
    assert.equal(Number(current.location_id),Number(job.snapshot.locationId));
    assert.ok(Number(current.fulfilled_quantity)/factor(current)+0.000001>=Number(saved.quantity));
    const records=linked.filter(l=>Number(l.source_id)===Number(job.local_to_id)&&Number(l.source_line)===Number(current.order_line)
      &&l.type===(outbound?'ItemShip':'ItemRcpt'));
    assert.ok(records.length,'Saved IF/IR linked to the exact directional source line');
    let total=0;
    for(const record of records) {
      assert.equal(Number(record.item_id),Number(saved.itemId));assert.equal(Number(record.location_id),Number(current.location_id));
      assert.equal(String(record.unit_id??''),String(current.unit_id??''));
      if(outbound)assert.equal(record.status,'C','IF must be shipped');
      total+=quantity(record);
      transactions.set(Number(record.id),{transactionType:job.transaction_type,sourceOrderKind:'TO',sourceNetSuiteId:Number(job.local_to_id),
        sourceOrderRef:job.order_ref,transactionId:Number(record.id),transactionRef:record.tranid,recovered:true});
    }
    assert.ok(same(total,saved.quantity),'Linked IF/IR quantity exactly matches the saved local job');
    proof.push({sourceLineKey:saved.sourceLineKey,sourceOrderLine:Number(current.order_line),itemId:Number(saved.itemId),quantity:total});
  }
  return {transactions:[...transactions.values()],lines:proof};
}

export function reviewCompletedSplit(candidate,header,lines,linked,remaining) {
  assert.ok(['SOA06143-S1','SOA08854-S1'].includes(candidate.dispatchOrderRef),'Reviewed split allowlist');
  const split=one(remaining.splits.filter(s=>s.split_ref===candidate.dispatchOrderRef&&s.active&&s.definition_kind==='split'),'Active split definition');
  assert.equal(split.parent_order_ref,header.tranid);
  const localOrder=one(remaining.orders.filter(o=>o.tranid===candidate.dispatchOrderRef),'Exact local child');
  const items=split.full_order.items.filter(i=>['InvtPart','NonInvtPart'].includes(i.itemType)&&Number(i.quantity)>0);
  const target=items.map(item=>{
    const source=one(lines.filter(l=>Number(l.source_id)===Number(header.id)&&String(l.source_line_key)===String(item.lineId)),'Split source key');
    const child=one(localOrder.lines.filter(l=>String(l.line_id)===String(item.lineId)&&Number(l.item_id)===Number(item.itemId)),'Child source identity');
    assert.ok(same(child.quantity,item.quantity));assert.equal(Number(source.item_id),Number(item.itemId));
    assert.equal(String(child.unit||'').toUpperCase(),String(source.unit||'').toUpperCase());
    return {source,child,item};
  });
  assert.equal(target.length,2);
  const transactions=[...new Set(linked.filter(l=>Number(l.source_id)===Number(header.id)&&l.type==='ItemShip').map(l=>l.id))];
  const matches=transactions.filter(id=>{
    const rows=linked.filter(l=>l.id===id);
    return rows.length===target.length&&target.every(({source,item})=>rows.some(r=>Number(r.source_line)===Number(source.order_line)
      &&r.status==='C'&&Number(r.item_id)===Number(source.item_id)&&Number(r.location_id)===Number(source.location_id)
      &&String(r.unit_id??'')===String(source.unit_id??'')&&same(quantity(r),item.quantity)));
  });
  const id=one(matches,'One existing IF exactly covers this split, without allocating another delivery quantity');
  const record=linked.find(l=>l.id===id);
  return {verified:{id:Number(id),transactionRef:record.tranid},localOrderId:Number(localOrder.netsuite_id),splitRef:split.split_ref,
    target:target.map(({source,child,item})=>({localLineId:child.id,sourceLineKey:String(source.source_line_key),quantity:Number(item.quantity)}))};
}
