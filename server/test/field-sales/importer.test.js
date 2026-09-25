import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlanningPages,readCkanPages } from '../../src/field-sales/importer.js';
async function collect(source){const result=[];for await(const page of source){result.push(...page);}return result;}
test('I3 planning reads every page and refuses duplicate/missing pages',async()=>{
  let calls=0;
  const fetchJson=async url=>{
    const u=new URL(url);calls++;
    if(!u.pathname.endsWith('/query')){return {editingInfo:{lastEditDate:1}};}
    if(u.searchParams.get('returnCountOnly')){return {count:2501};}
    const start=Number(u.searchParams.get('resultOffset'));
    return {features:Array.from({length:Math.min(1000,2501-start)},(_,i)=>({attributes:{OBJECTID:start+i,FOLDERRSN:start+i+1}}))};
  };
  assert.equal((await collect(readPlanningPages({fetchJson}))).length,2501);assert.equal(calls,6);
  const truncated=async url=>url.includes('resultOffset=1000')?{features:[]}:fetchJson(url);
  await assert.rejects(collect(readPlanningPages({fetchJson:truncated})),/incomplete|page/i);
});
test('I4 CKAN validates stable totals and source identity across pages',async()=>{
  const fetchJson=async url=>{
    const u=new URL(url);if(u.pathname.endsWith('resource_show')){return {success:true,result:{metadata_modified:'a'}};}
    const offset=Number(u.searchParams.get('offset'));
    return {success:true,result:{total:3,records:offset? [{_id:3}]:[{_id:1},{_id:2}]}};
  };
  assert.equal((await collect(readCkanPages('resource',{fetchJson,pageSize:2}))).length,3);
  const duplicates=async url=>url.includes('offset=2')?{success:true,result:{total:3,records:[{_id:2}]}}:fetchJson(url);
  await assert.rejects(collect(readCkanPages('resource',{fetchJson:duplicates,pageSize:2})),/duplicate/i);
});
