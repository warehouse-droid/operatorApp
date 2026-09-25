import {randomUUID} from 'node:crypto';
import {query} from '../../src/db.js';
import {torontoDate} from '../../public/field-sales/domain.js';

export async function seedRecent(today=torontoDate()) {
  if(process.env.MBT_TEST_ISOLATED!=='1'||!String(process.env.DATABASE_URL).includes('mbt_test')){throw new Error('Disposable database required.');}
  const prefix=`Recent leads ${randomUUID()}`,ids={},records={};
  const day=ago=>new Date(Date.parse(`${today}T12:00:00Z`)-ago*86400000).toISOString().slice(0,10);
  const permit=(issued=day(1),patch={})=>({source:'permit',category:'New Houses',status:'Permit Issued',rank:35,minor:false,date:issued,raw:{PERMIT_NUM:'TEST HOUSE',ISSUED_DATE:issued,APPLICATION_DATE:issued,WORK:'New Building'},...patch});
  async function add(name,sources=[],manual=false,priority=0) {
    const id=ids[name]=randomUUID(),address=name==='oldDrain'?'276 PRINCE EDWARD DR S':`${Object.keys(ids).length} Recent Test Road`;
    await query('INSERT INTO field_sales_jobsites(id,name,address,address_key,latitude,longitude,ward,district,manual,priority) VALUES($1,$2,$3,$4,43.71,-79.57,\'01\',\'Etobicoke-York\',$5,$6)',[id,`${prefix} ${name}`,address,address,manual,priority]);
    records[name]=sources;
    for(const [index,data] of sources.entries()){await query('INSERT INTO field_sales_sources(source,source_key,jobsite_id,address_key,data) VALUES($1,$2,$3,$4,$5)',[data.source,`${id}:${index}`,id,address,JSON.stringify({...data,address})]);}
  }
  await add('oldDrain',[permit('2022-04-12',{category:'Drain and Site Service',status:'Inspection',rank:40,raw:{PERMIT_NUM:'22 127851 DRN',ISSUED_DATE:'2022-04-12',APPLICATION_DATE:'2022-03-28',WORK:'Back Water Valve (Sewer only)'},description:'bwv installation'})]);
  await add('house',[permit(day(1),{description:'New house including plumbing and backwater valve installation.'})]);
  await add('foundation',[permit(day(3),{category:'Partial Permit',status:'Inspection',rank:40,raw:{ISSUED_DATE:day(3),WORK:'Partial Permit - Foundation'}})]);
  await add('ready',[permit(null,{status:'Ready for Issuance',rank:25,raw:{ISSUED_DATE:'',APPLICATION_DATE:day(2),WORK:'Addition(s)'}})]);
  await add('complete',[{source:'planning',category:'Site Plan Control',status:'Under Review',rank:0,milestone:'Notice of Complete Application Issued',date:day(2)+'T00:00:00.000Z'}]);
  await add('approved',[{source:'planning',category:'Site Plan Control',status:'Approved',rank:30,milestone:'Statement of Approval Issued',date:day(4)+'T00:00:00.000Z'}]);
  await add('oldHouse',[permit('2022-04-12',{status:'Inspection',rank:40})]);
  await add('undated',[permit(null)]);
  await add('mixed',[permit('2022-04-12',{status:'Inspection',rank:40}),permit(day(1),{category:'Plumbing',minor:true})]);
  await add('differentStatus',[permit('2022-04-12',{status:'Inspection',rank:40}),permit(day(1),{category:'Demolition Folder (DM)'})]);
  await add('badIssued',[permit('2026-02-30',{raw:{ISSUED_DATE:'2026-02-30',APPLICATION_DATE:day(5),WORK:'New Building'}})]);
  await add('badDate',[permit('not-a-date',{raw:{ISSUED_DATE:'not-a-date',APPLICATION_DATE:'2026-99-99',WORK:'New Building'}})]);
  await add('manual',[],true);
  await add('priority',[permit(day(30))],false,3);
  await add('atCutoff',[permit('2025-09-18')]);await add('beforeCutoff',[permit('2025-09-17')]);
  for(const [name,category,work] of [
    ['newDrain','Drain and Site Service','Back Water Valve (Sewer only)'],['standaloneDrain','Drain and Site Service','Inside and Outside Drains'],
    ['sign','Designated Structures','Sign Building Permit Related'],['solar','Designated Structures','Solar Collector'],
    ['admin','Small Residential Projects','Party Wall Admin Permits'],['useOnly','Building Additions/Alterations','Change of Use'],['windowOnly','Building Additions/Alterations','Window Replacement'],
    ['buildingDrain','Drain and Site Service','Building Permit Related (DR)'],['siteService','Drain and Site Service','Site Service'],
    ['conditionalDrain','Conditional Permit','Inside and Outside Drains'],['unclear','Small Residential Projects','Other(SR)']
  ]){await add(name,[permit(day(1),{category,raw:{ISSUED_DATE:day(1),WORK:work}})]);}
  return {prefix,ids,records,today};
}
