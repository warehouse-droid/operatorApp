/* global window */
(() => {
  const filterFields=['sellingYardId','vendorKey','itemId','customerId'];
  const numericFields=new Set(['requestedQty','waitingQty','heldQty']);
  const sortFields=new Set(['createdAt','requestRef','customerName','vendorName','itemCode','sellingYard',...numericFields]);
  const textCompare=(a,b)=>String(a??'').localeCompare(String(b??''),'en-CA',{numeric:true,sensitivity:'base'});
  const age=(a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||Number(a.id)-Number(b.id);
  /** @param {Record<string,any>[]} rows @param {{filters?:Record<string,string>,sortBy?:string,direction?:string}} [settings] */
  function select(rows,settings={}){
    const filters=settings.filters||{},sortBy=sortFields.has(settings.sortBy)?settings.sortBy:'createdAt',direction=settings.direction==='desc'?-1:1;
    const filtered=rows.filter(row=>filterFields.every(field=>!filters[field]||String(row[field]??'')===String(filters[field])));
    return filtered.sort((a,b)=>{
      const comparison=sortBy==='createdAt'?Date.parse(a.createdAt)-Date.parse(b.createdAt):numericFields.has(sortBy)?Number(a[sortBy])-Number(b[sortBy]):textCompare(a[sortBy],b[sortBy]);
      return comparison*direction||age(a,b);
    });
  }
  function facets(rows){
    const labels={sellingYardId:r=>r.sellingYard,vendorKey:r=>r.vendorName||'No vendor',itemId:r=>r.itemCode,customerId:r=>r.customerName};
    return Object.fromEntries(filterFields.map(field=>{
      const values=new Map();for(const row of rows)values.set(String(row[field]),String(labels[field](row)));
      return [field,[...values].map(([value,label])=>({value,label})).sort((a,b)=>textCompare(a.label,b.label))];
    }));
  }
  window.SCMWaitlistList={select,facets};
})();
