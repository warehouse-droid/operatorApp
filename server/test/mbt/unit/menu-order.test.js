import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import fs from 'node:fs';
import {MENU_CATALOG,normalizeMenuOrders,orderMenuItems,moveMenuItem,sanitizeStoredMenuOrders} from '../../../public/menu-order-model.js';

const sales = ['/sales/planning','/sales/printing','/sales/delivery-requests'];
test('partial order preserves all existing items and stable unlisted ties', () => {
  const items = sales.map(href => ({href}));
  assert.deepEqual(orderMenuItems(items, [sales[2],'/removed']), [items[2],items[0],items[1]]);
  assert.deepEqual(items.map(item=>item.href),sales);
  assert.deepEqual(orderMenuItems(items,[]),items);
});
test('configuration accepts only known unique menu links and known groups', () => {
  assert.deepEqual(normalizeMenuOrders({sales:[sales[2],sales[0]]}), {sales:[sales[2],sales[0]]});
  for (const orders of [null,[],true,{sales:null},{sales:[sales[0],sales[0]]},
    {sales:['/admin']},{sales:['javascript:alert(1)']},{unknown:[]},{sales:[1]}]) {
    assert.throws(()=>normalizeMenuOrders(orders),error=>error.status===400);
  }
  assert.deepEqual(normalizeMenuOrders({}),{});
});
test('moving by position works in both directions and does not mutate the input',()=>{
  assert.deepEqual(moveMenuItem(sales,0,2),[sales[1],sales[2],sales[0]]);
  assert.deepEqual(moveMenuItem(sales,2,0),[sales[2],sales[0],sales[1]]);
  assert.deepEqual(moveMenuItem(sales,1,1),sales);
  for (const [from,to] of [[-1,0],[0,3],[0,1.5]]) assert.throws(()=>moveMenuItem(sales,from,to));
});
test('catalog has independent groups, unique links and the admin editor',()=>{
  assert.equal(new Set(MENU_CATALOG.map(menu=>menu.key)).size,MENU_CATALOG.length);
  for (const menu of MENU_CATALOG) assert.equal(new Set(menu.items.map(item=>item.href)).size,menu.items.length);
  assert.ok(MENU_CATALOG.find(menu=>menu.key==='admin').items.some(item=>item.href==='/admin/menu-order'));
  const sidebar=fs.readFileSync(new URL('../../../public/app-sidebar.js',import.meta.url),'utf8');
  for(const menu of MENU_CATALOG) {
    const block=sidebar.match(new RegExp(`const ${menu.key}Items = \\[([\\s\\S]*?)\\n  \\];`))[1];
    const items=[...block.matchAll(/\{ label: "([^"]+)", href: "([^"]+)"/gu)].map(match=>({label:match[1],href:match[2]}));
    assert.deepEqual(menu.items,items,`${menu.label} catalog must track the sidebar`);
  }
});
test('stored orders survive removed pages and retain valid priority without permitting new invalid writes',()=>{
  assert.deepEqual(sanitizeStoredMenuOrders({sales:['/retired',sales[0],sales[0]],retired:['/retired']}),{sales:[sales[0]]});
  assert.deepEqual(sanitizeStoredMenuOrders({main:'bad',sales:null}),{});
  assert.throws(()=>normalizeMenuOrders({sales:['/retired']}));
});
test('generated orders preserve membership, hide no items and obey known priority',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.integer({min:0,max:39}),{minLength:1,maxLength:40}),
    fc.array(fc.integer({min:0,max:50}),{maxLength:60}),(values,priorities)=>{
      const items=values.map(id=>({href:`/item/${id}`})), before=structuredClone(items);
      const requested=[...new Set(priorities)].map(id=>`/item/${id}`);
      const result=orderMenuItems(items,requested);
      assert.deepEqual(items,before);
      assert.deepEqual(result.map(item=>item.href).sort(),items.map(item=>item.href).sort());
      const wanted=requested.filter(href=>items.some(item=>item.href===href));
      assert.deepEqual(result.slice(0,wanted.length).map(item=>item.href),wanted);
      assert.deepEqual(result.slice(wanted.length).map(item=>item.href),items.map(item=>item.href).filter(href=>!wanted.includes(href)));
    }),{seed:6102026,numRuns:400});
});
