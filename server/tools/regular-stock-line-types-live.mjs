// User-authorized survey of stored line types. No customer data or order writes.
const {query,withTransaction,closeDb}=await import(process.cwd()+'/src/db.js');
try{
 const evidence=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const types=(await query(`SELECT COALESCE(NULLIF(item_type,''),'(missing)') AS item_type,
    count(*)::int AS lines,count(DISTINCT sales_order_id)::int AS orders
    FROM sales_order_lines GROUP BY 1 ORDER BY lines DESC`)).rows;
  const pricing=(await query(`SELECT item_id,item_name,item_type,count(*)::int AS lines,
    count(*) FILTER(WHERE quantity IS NULL OR quantity=0)::int AS quantityless_lines
    FROM sales_order_lines WHERE item_id IN (1784,-2,1987,3013,2022,10716)
    GROUP BY item_id,item_name,item_type ORDER BY item_id,item_name`)).rows;
  return{readOnly:true,types,pricing};
 });
 console.log(JSON.stringify(evidence));
}finally{await closeDb();}
