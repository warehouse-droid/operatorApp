import { fail, text, COMPANIES } from '../../public/field-sales/domain.js';
import { suggestedRate } from '../../public/field-sales/pricing.js';

export function createSalesCatalog(repo,{reader}={}) {
  const db=repo.db;
  const locked=operation=>db.transaction(async()=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('field-sales-trade-catalog'))");
    if(!reader){throw fail('NetSuite pricing is not configured.',409);}
    return operation();
  });
  async function put(item) {
    await db.query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit,unit_rate,pricing)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company,item_id) DO UPDATE SET
      sku=EXCLUDED.sku,description=EXCLUDED.description,unit=EXCLUDED.unit,unit_rate=EXCLUDED.unit_rate,
      pricing=EXCLUDED.pricing,active=true,updated_at=now()`,[item.company,item.item_id,item.sku,item.description,item.unit,item.unit_rate,JSON.stringify(item.pricing)]);
  }
  async function refresh() {
    return locked(async()=>{
      const settings=await repo.settings(),items=[];
      for(const company of COMPANIES){items.push(...await reader.items(company,settings.data.companies[company]));}
      if(!items.length){throw fail('NetSuite returned an empty catalog; previous catalog retained.',409);}
      if((await repo.settings()).revision!==settings.revision){throw fail('Company settings changed; refresh the catalog again.',409);}
      await db.query('UPDATE field_sales_catalog SET active=false');
      for(const item of items){await put(item);}
      return {count:items.length};
    });
  }
  async function search({company,search:term='',limit=40}={}) {
    if(company&&!COMPANIES.includes(company)){throw fail('Unknown company.');}
    return (await db.query(`SELECT * FROM field_sales_catalog WHERE active AND ($1::text IS NULL OR company=$1) AND (sku ILIKE $2 OR description ILIKE $2) ORDER BY company,sku,item_id LIMIT $3`,[company||null,`%${text(term,150)}%`,Math.min(200,Math.max(1,Number(limit)||40))])).rows;
  }
  async function price(company,itemId,input={}) {
    if(!COMPANIES.includes(company)){throw fail('Unknown company.');}
    const id=text(itemId,80);
    const active=(await db.query('SELECT 1 FROM field_sales_catalog WHERE company=$1 AND item_id=$2 AND active',[company,id])).rowCount;
    if(!active){throw fail('Active catalog item not found.',404);}
    return locked(async()=>{
      const settings=await repo.settings(),items=await reader.items(company,settings.data.companies[company],id),item=items.find(i=>i.item_id===id&&i.company===company);
      if(!item){throw fail('This item is no longer available to the selected company. Refresh the catalog.',409);}
      if((await repo.settings()).revision!==settings.revision){throw fail('Company settings changed; refresh the price again.',409);}
      const rate=suggestedRate(item,String(input.quantity??'1'));await put(item);
      return {...item,unit_rate:rate};
    });
  }
  async function customers(term='') {
    return (await db.query(`SELECT netsuite_id::text AS id,entity_number,display_name,email,phone,currency FROM netsuite_customers WHERE active AND currency='CAD' AND (display_name ILIKE $1 OR entity_number ILIKE $1 OR netsuite_id::text=$2) ORDER BY display_name,netsuite_id LIMIT 40`,[`%${text(term,150)}%`,text(term,40)])).rows;
  }
  return {refresh,search,price,customers};
}
