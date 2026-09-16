import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { isLocalCoLoaded, projectLoadedCoLine } from "../../../src/local-co-loaded-policy.js";

test("CO load evidence displays Loaded while unfinished and cancelled COs stay unchanged",()=>{
  for(const co of [{status:"loaded"},{status:"completed"},{status:"planned",loaded_at:"2026-09-15T00:00:00Z"},
    {status:"planned",details:{sourceCompletionCleanup:{observedAt:"2026-09-15T00:00:00Z"}}}]) assert.equal(isLocalCoLoaded(co),true);
  for(const co of [{status:"pending_load"},{status:"packed"},{status:"cancelled",loaded_at:"2026-09-15T00:00:00Z"},
    {status:"planned"},{}]) assert.equal(isLocalCoLoaded(co),false);
});
test("property: loaded CO lines retain cargo and receipts and show no packing remaining",()=>{
  fc.assert(fc.property(fc.integer({min:0,max:10000}),fc.integer({min:0,max:10000}),(required,received)=>{
    const line={quantity:required,unit:"EA",received_sales_qty:received,packed_sales_qty:3,packed_piece_qty:4,loaded_qty:0};
    const after=projectLoadedCoLine(line,required);
    assert.equal(after.loaded_qty,required);
    assert.equal(after.quantity,required);
    assert.equal(after.unit,"EA");
    assert.equal(after.received_sales_qty,received);
    assert.equal(after.packed_sales_qty,0);
    assert.equal(after.packed_piece_qty,0);
    assert.deepEqual(projectLoadedCoLine(after,required),after);
    assert.equal(line.loaded_qty,0);
  }),{seed:20260915,numRuns:200});
});
