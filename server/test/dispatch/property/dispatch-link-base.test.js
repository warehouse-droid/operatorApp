import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { dispatchLinkPhysicalQuantities, projectPurchaseOrderRouteResidual } from '../../../src/dispatch-po-route-projection.js';

test('base allocation conserves each order packing over randomized partial quantities',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:1000}),fc.integer({min:0,max:1000}),
    (total,packing,fraction)=>{
      const quantity=total*fraction/1000;
      const item={lineRowId:'1',quantity:total,pallets:packing,pieces:packing*2,unit:'EACH'};
      const result=dispatchLinkPhysicalQuantities(quantity,item);
      assert.equal(result.pallets,Number((packing*fraction/1000).toFixed(6)));
      assert.equal(result.pieces,Number((packing*2*fraction/1000).toFixed(6)));
      const po=projectPurchaseOrderRouteResidual({id:'PO-PROPERTY',type:'PO',sourceYard:'Vendor',destinationYard:'2967',items:[item]},
        [{po_line_id:'1',allocated_sales_qty:quantity,allocated_pallet_qty:999999,details:{quantityBasis:'base'}}]);
      const residual=po.poRouteProjection.items[0];
      assert.equal(residual?.quantity||0,Number((total-quantity).toFixed(6)));
      assert.ok(Math.abs((residual?.pallets||0)+result.pallets-packing)<=0.000001);
      assert.ok(Math.abs((residual?.pieces||0)+result.pieces-packing*2)<=0.000001);
    }),{seed:3022301585,numRuns:400});
});

test('conversion-only lines retain fractional packing and no conversion retains base count',()=>{
  assert.deepEqual(dispatchLinkPhysicalQuantities(5.23,{quantity:10.46,toPlt:104.6,toLyr:10.46}),
    {pallets:0,layers:0.5,sections:0,pieces:0});
  assert.deepEqual(dispatchLinkPhysicalQuantities(3,{quantity:10,unit:'EACH'}),
    {pallets:0,layers:0,sections:0,pieces:3});
});

test('area and weight base quantities without packing never become invented piece counts',()=>{
  for(const unit of ['SQFT','KG','BOX']) assert.deepEqual(dispatchLinkPhysicalQuantities(5.23,{quantity:10.46,unit}),
    {pallets:0,layers:0,sections:0,pieces:0});
});
