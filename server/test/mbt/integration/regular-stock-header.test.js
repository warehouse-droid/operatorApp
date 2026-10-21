import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {readRegularSalesOrder} from '../../../src/regular-stock-netsuite-adapter.js';

test.after(closeDb);

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await withTransaction(async()=>{
    await query(`CREATE TEMP TABLE transaction(id bigint,tranid text,location bigint,entity bigint,status text,type text DEFAULT 'SalesOrd');
      CREATE TEMP TABLE transactionline(transaction bigint,id bigint,uniquekey bigint,item bigint,quantity numeric,
        location bigint,quantityshiprecv numeric,quantitybilled numeric,isclosed text,mainline text,taxline text);
      ALTER TABLE transactionline ADD COLUMN quantitybackordered numeric DEFAULT 0;
      ALTER TABLE transactionline ADD COLUMN kitmemberof bigint;
      CREATE TEMP TABLE item(id bigint,stockunit bigint,itemtype text);
      CREATE SCHEMA IF NOT EXISTS builtin;
      CREATE OR REPLACE FUNCTION builtin.df(value bigint) RETURNS text LANGUAGE SQL AS $$
        SELECT CASE WHEN value=301 THEN 'SQFT' ELSE 'Material '||value::text END $$;
      INSERT INTO item VALUES(4757,301,'InvtPart');
      INSERT INTO transaction(id,tranid,location,entity,status) VALUES(1024553,'SO-HEADER',NULL,8444,'B'),(1024554,'SO-OTHER',28,55,'B');
      INSERT INTO transactionline(transaction,id,uniquekey,item,quantity,location,quantityshiprecv,quantitybilled,isclosed,mainline,taxline) VALUES
        (1024553,0,5044331,NULL,NULL,1,0,0,'F','T','F'),
        (1024553,1,5044332,4757,-523,1,0,0,'F','F','F'),
        (1024554,0,5044400,NULL,NULL,28,0,0,'F','T','F');`);
    let restLocation=1,restCustomer=8444,materialLocation=1;
    const boundary={
      // Execute the real join and projection; only Oracle's NVL spelling differs.
      queryAll:async sql=>(await query(sql.replaceAll('NVL(','COALESCE('))).rows,
      rest:async(_path,options={})=>{
        assert.equal(options.method,undefined,'Reading an SO must never mutate NetSuite');
        return {data:{id:'1024553',tranId:'SO-HEADER',location:{id:String(restLocation)},entity:{id:String(restCustomer)},
          item:{items:[{line:1,item:{id:'4757'},quantity:523,location:{id:String(materialLocation)},rate:1}]}}};
      },
      resolveYards:async()=>[1,28,15,26].map(id=>({localLocationId:id,netsuiteLocationId:id}))
    };
    await run({boundary,setRest:(location,customer=8444,lineLocation=location)=>{
      restLocation=location;restCustomer=customer;materialLocation=lineLocation;
    }});
  },{rollback:true});
}

test('SO with blank transaction-body location reads its matching main-line/REST ordering yard',async()=>fixture(async({boundary})=>{
  const order=await readRegularSalesOrder('SO-HEADER',boundary);
  assert.equal(order.locationId,1);assert.equal(order.remoteLocationId,1);assert.equal(order.customerId,8444);
  assert.deepEqual(order.lines.map(line=>[line.remoteLineId,line.itemId,line.quantity,line.locationId,line.open]),[[5044332,4757,523,1,true]]);
}));

test('ordering yard is the same SO main line even when body, material and other SO locations differ',async()=>fixture(async({boundary,setRest})=>{
  await query('UPDATE transaction SET location=26 WHERE id=1024553');
  await query("UPDATE transactionline SET location=15 WHERE transaction=1024553 AND mainline='F'");
  setRest(1,8444,15);
  const order=await readRegularSalesOrder('SO-HEADER',boundary);
  assert.equal(order.locationId,1);assert.equal(order.lines[0].locationId,15);
}));

test('built-in subtotal survives the SQL join without a positive inventory item or quantity',async()=>fixture(async({boundary})=>{
  await query("INSERT INTO transactionline(transaction,id,uniquekey,item,quantity,location,quantityshiprecv,quantitybilled,isclosed,mainline,taxline) VALUES(1024553,2,5044333,-2,NULL,1,0,0,'F','F','F')");
  const rest=boundary.rest;
  boundary.rest=async(...args)=>{
    const response=await rest(...args);
    response.data.item.items.push({line:2,item:{id:'-2'},location:{id:'1'},isClosed:false});
    return response;
  };
  const order=await readRegularSalesOrder('SO-HEADER',boundary);
  assert.equal(order.lines.length,2);
  assert.equal(order.lines[1].itemId,-2);assert.equal(order.lines[1].ancillary,true);
  assert.equal(order.lines[1].quantity,null);assert.equal(order.lines[1].restQuantity,null);
  assert.equal(order.lines[0].ancillary,false);
}));

test('header identity property: only matching main-line/REST location and customer can be read',async()=>fixture(async({boundary,setRest})=>{
  let subtotal=false;
  const rest=boundary.rest;
  boundary.rest=async(...args)=>{
    const response=await rest(...args);
    if(subtotal)response.data.item.items.push({line:2,item:{id:'-2'},location:{id:'1'},isClosed:false});
    return response;
  };
  const cases=fc.record({header:fc.integer({min:1,max:100}),material:fc.integer({min:101,max:200}),
    body:fc.option(fc.integer({min:201,max:300}),{nil:null}),customer:fc.integer({min:1,max:100000}),
    hasSubtotal:fc.boolean(),mismatch:fc.constantFrom('none','location','customer','missing-main')});
  await fc.assert(fc.asyncProperty(cases,async({header,material,body,customer,hasSubtotal,mismatch})=>{
    subtotal=hasSubtotal;
    await query('DELETE FROM transactionline WHERE transaction=1024553 AND id=2');
    if(subtotal)await query("INSERT INTO transactionline(transaction,id,uniquekey,item,quantity,location,quantityshiprecv,quantitybilled,isclosed,mainline,taxline) VALUES(1024553,2,5044333,-2,NULL,1,0,0,'F','F','F')");
    await query('UPDATE transaction SET location=$1,entity=$2 WHERE id=1024553',[body,customer]);
    await query("UPDATE transactionline SET location=$1,mainline=$2 WHERE transaction=1024553 AND id=0",[header,mismatch==='missing-main'?'F':'T']);
    await query('UPDATE transactionline SET location=$1 WHERE transaction=1024553 AND id=1',[material]);
    setRest(mismatch==='location'?header+300:header,mismatch==='customer'?customer+100000:customer,material);
    if(mismatch==='none'){
      const order=await readRegularSalesOrder('SO-HEADER',boundary);
      assert.equal(order.locationId,header);assert.equal(order.customerId,customer);assert.equal(order.lines[0].locationId,material);
      assert.equal(order.lines.length,subtotal?2:1);
    }else{
      await assert.rejects(()=>readRegularSalesOrder('SO-HEADER',boundary),error=>error.code==='REGULAR_SO_MISMATCH');
    }
  }),{numRuns:150,seed:121631});
}));
