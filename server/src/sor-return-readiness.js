import {query} from './db.js';

export async function getSorReturnReadiness(refs = []) {
  const returns = refs.filter(ref => /^SOR\d+(?:-S\d+)?-Return$/iu.test(String(ref)));
  if (!returns.length) {return [];}
  const rows = (await query(`SELECT r.ref_number,r.parent_order_ref,r.status,r.sor_review_reason,r.pickup_location
    FROM dispatch_custom_orders r WHERE r.order_kind='sor_rental_return' AND lower(r.ref_number)=ANY($1::text[])`,
  [returns.map(ref => ref.toLowerCase())])).rows;
  return returns.map(ref => {
    const row = rows.find(value => value.ref_number.toLowerCase() === ref.toLowerCase());
    const message = !row || row.status !== 'open' ? `${ref} is not an open rental return.`
      : row.sor_review_reason ? `${ref} needs Dispatch review: ${row.sor_review_reason}`
        : !row.pickup_location.trim() ? `${ref} needs a customer pickup address.` : '';
    return {orderRef: ref, parentOrderRef: row?.parent_order_ref || '', allowed: !message,
      code: message ? 'SOR_RETURN_NOT_READY' : '', message};
  });
}

export async function assertSorReturnReady(job) {
  if (job?.stopType !== 'pickup' || job.status === 'in_progress' || job.status === 'complete') {return;}
  const blocked = (await getSorReturnReadiness(job.orderRefs || [])).find(row => !row.allowed);
  if (blocked) {throw Object.assign(new Error(blocked.message), {status: 409, code: blocked.code});}
}
