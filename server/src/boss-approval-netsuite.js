import {bossError,normalizeSnapshot,positiveId} from './boss-approval-domain.js';

export function createBossNetSuiteAdapter({rest,queryAll,mutate}) {
  async function closedSnapshot(id,error) {
    if(error.status!==400||!error.netsuiteErrorCodes?.includes('USER_ERROR')||
      !/record has been locked by a user defined workflow/i.test(error.message)){throw error;}
    // Closed-state workflows can block even GET. Query only the exact SalesOrd;
    // terminal evidence must never manufacture actionable financial information.
    const rows=await queryAll("SELECT id,tranid,status,entity,lastmodifieddate FROM transaction WHERE type='SalesOrd' AND id="+id);
    const row=rows[0];
    if(rows.length!==1||Number(row?.id)!==id||row.status!=='H'||!row.tranid||!row.entity){throw error;}
    return normalizeSnapshot({orderId:id,tranid:row.tranid,status:'H',customerId:row.entity,orderVersion:row.lastmodifieddate});
  }
  async function customerCurrency(customer) {
    if(!customer.currency?.id){return '';}
    const {data}=await rest(`/record/v1/currency/${positiveId(customer.currency.id)}`);
    return data?.symbol||data?.name||customer.currency.refName||'';
  }
  async function read(orderId) {
    const id=positiveId(orderId);
    let order;
    try {({data:order}=await rest(`/record/v1/salesOrder/${id}`));}
    catch(error){return closedSnapshot(id,error);}
    if(Number(order?.id)!==id||!order.orderStatus?.id){throw bossError('NetSuite did not return a valid sales order status.',502);}
    const customerId=positiveId(order.entity?.id);
    const {data:customer}=await rest(`/record/v1/customer/${customerId}`);
    if(Number(customer?.id)!==customerId){throw bossError('NetSuite did not return the expected customer.',502);}
    const currency=await customerCurrency(customer);
    return normalizeSnapshot({orderId:id,tranid:order.tranId,status:order.orderStatus.id,
      customerId,customerName:customer.companyName||order.entity.refName,
      ownerId:customer.custentity4?.id,ownerName:customer.custentity4?.refName,
      creditLimit:customer.creditLimit,balance:customer.balance,unbilledOrders:customer.unbilledOrders,currency,
      orderVersion:order.lastModifiedDate,orderTotal:order.total});
  }
  async function approve(orderId,{beforeSend=async()=>{}}={}) {
    const id=positiveId(orderId);
    return mutate(async()=>{
      await beforeSend();
      return rest(`/record/v1/salesOrder/${id}`,{method:'PATCH',body:{orderStatus:{id:'B'}}});
    });
  }
  const pending=()=>queryAll("SELECT id,tranid FROM transaction WHERE type='SalesOrd' AND status='A' ORDER BY id");
  function closeItems(order,id,expectedVersion) {
    const lines=order?.item?.items;
    if(Number(order?.id)!==id||order.orderStatus?.id!=='A'||
      (expectedVersion&&order.lastModifiedDate!==expectedVersion)||
      !Array.isArray(lines)||!lines.length||order.item.hasMore||
      (order.item.totalResults!=null&&Number(order.item.totalResults)!==lines.length)){
      throw bossError('The complete pending sales order could not be verified. Refresh and confirm again.',409);
    }
    const ids=lines.map(line=>positiveId(line.line));
    if(new Set(ids).size!==lines.length||lines.some(line=>typeof line.isClosed!=='boolean')){
      throw bossError('The exact sales order lines could not be verified.',409);
    }
    return lines.filter(line=>!line.isClosed).map(line=>({line:positiveId(line.line),isClosed:true}));
  }
  /** @param {number} orderId @param {{beforeSend?:()=>Promise<any>,expectedVersion?:string|null}} [options] */
  async function close(orderId,{beforeSend=async()=>{},expectedVersion=null}={}) {
    const id=positiveId(orderId);
    return mutate(async()=>{
      let items;
      try {
        const {data:order}=await rest(`/record/v1/salesOrder/${id}?expandSubResources=true`);
        items=closeItems(order,id,expectedVersion);
        await beforeSend();
      }catch(error){throw Object.assign(error,{bossNoWrite:true});}
      if(!items.length){return;}
      return rest(`/record/v1/salesOrder/${id}`,{method:'PATCH',body:{item:{items}}});
    });
  }
  return {read,approve,close,pending};
}
