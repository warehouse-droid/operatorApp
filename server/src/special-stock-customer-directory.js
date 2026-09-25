import {query} from './db.js';

// The canonical import currently covers MBT. The complete active NetSuite
// snapshot also contains MBBS accounts; never fabricate canonical customer data.
/** @param {unknown} [search] @param {unknown} [limit] */
export async function searchSpecialCustomerDirectory(search = '', limit = 30) {
  const term=String(search ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120).toLowerCase();
  const count=Number(limit);
  const bounded=Number.isFinite(count) && count>0 ? Math.min(80,Math.max(1,Math.trunc(count))) : 30;
  const result=await query(`WITH customers AS (
    SELECT netsuite_id AS id,entity_number,display_name,legal_name,phone,email,currency
      FROM netsuite_customers WHERE active=true
    UNION ALL
    SELECT d.netsuite_customer_id,d.entity_code,d.display_name,d.company_name,d.phone,'' AS email,NULL AS currency
      FROM return_customer_directory d
     WHERE NOT EXISTS(SELECT 1 FROM netsuite_customers c WHERE c.netsuite_id=d.netsuite_customer_id)
  ) SELECT * FROM customers
    WHERE $1='' OR strpos(lower(entity_number),$1)>0 OR strpos(lower(display_name),$1)>0
      OR strpos(lower(legal_name),$1)>0 OR id::text=$1
    ORDER BY CASE WHEN lower(entity_number)=$1 OR id::text=$1 THEN 0
      WHEN left(lower(entity_number),length($1))=$1 THEN 1 ELSE 2 END,display_name,id
    LIMIT $2`,[term,bounded]);
  return result.rows.map(/** @param {{id:string|number,entity_number:string,display_name:string,legal_name:string,phone:string,email:string,currency:string|null}} row */ row=>({id:Number(row.id),entityNumber:row.entity_number,
    displayName:row.display_name || row.legal_name || row.entity_number,legalName:row.legal_name,
    phone:row.phone || '',email:row.email || '',currency:row.currency}));
}

// Call inside the enquiry/SO transaction so a selected snapshot row cannot
// disappear or become inactive while the case is being saved.
/** @param {unknown} customerId */
export async function findSpecialCustomer(customerId) {
  const id=Number(customerId);
  if(!Number.isSafeInteger(id) || id<=0)return null;
  const canonical=await query('SELECT netsuite_id,display_name,legal_name,phone,active FROM netsuite_customers WHERE netsuite_id=$1 FOR SHARE',[id]);
  if(canonical.rowCount){
    const row=canonical.rows[0];
    return row.active ? {id,canonicalId:id,directoryId:null,name:row.display_name || row.legal_name,phone:row.phone || ''} : null;
  }
  const directory=await query('SELECT display_name,company_name,entity_code,phone FROM return_customer_directory WHERE netsuite_customer_id=$1 FOR SHARE',[id]);
  const row=directory.rows[0];
  return row ? {id,canonicalId:null,directoryId:id,name:row.display_name || row.company_name || row.entity_code,phone:row.phone || ''} : null;
}
