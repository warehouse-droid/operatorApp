import crypto from 'node:crypto';
import { query, withTransaction, afterTransactionCommit } from './db.js';
import { getDeliveryInstruction } from './delivery-instruction-repository.js';
import {createDeliveryRequestDocuments} from './delivery-request-documents.js';
import {getDeliveryRequestTransferOrder} from './delivery-request-orders.js';
import { DELIVERY_YARDS, DeliveryRequestError, assertDeliveryYard, normalizeDeliveryPricing,
  normalizeDeliverySettings, normalizeDeliveryWindow, calculateDeliveryQuote,
  transitionDeliveryRequest, deliveryApprovalDue,deliveryBillingOutbounds,
  deliveryJourneyRoutes,calculateDeliveryJourneyQuote,DELIVERY_AGGREGATES } from './delivery-request-domain.js';

const failure = (code, message, status = 400) => new DeliveryRequestError(code, message, status);
function canonical(value) {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (value && typeof value === 'object') {return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));}
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const iso = value => value ? new Date(value).toISOString() : null;
const actorName=actor=>actor?.displayName || actor?.username || actor?.id || 'System';
function mapRequest(row) {
  return { ...row.data, id: Number(row.id), requestRef: `DR-${String(row.id).padStart(6, '0')}`,
    requestingYardLocationId: row.requesting_yard_location_id, status: row.status, revision: row.revision,
    approvalExpiresAt: iso(row.approval_expires_at), reminderAt: iso(row.reminder_at), reminderSentAt: iso(row.reminder_sent_at),
    createdBy: row.created_by, lastActorId: row.last_actor_id, lastAction: row.last_action,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function audienceYards(actor, audience) {
  return Object.keys(DELIVERY_YARDS).map(Number).filter(yard => {
    try { assertDeliveryYard(actor, yard, audience); return true; } catch { return false; }
  });
}
function requireAudience(actor, audience) {
  const yards = audienceYards(actor, audience);
  if (!yards.length) {throw failure('DELIVERY_ACCESS_DENIED', 'Private Sales or Dispatch access is required.', 403);}
  return yards;
}
function text(value, limit, label) {
  if (value !== undefined && value !== null && typeof value !== 'string') {throw failure('DELIVERY_REQUEST_INVALID', `${label} must be text.`);}
  const result = String(value || '').trim();
  if (result.length > limit) {throw failure('DELIVERY_REQUEST_INVALID', `${label} exceeds ${limit} characters.`);}
  return result;
}
function actionMessage(action,current,next,reply) {
  const slot=window=>`${window.date} ${window.start}–${window.end}`;
  const includesTransfer=[...(current.salesOrderRefs || []),...(next.salesOrderRefs || [])].some(ref=>ref.startsWith('TO'));
  const messages={
    relink:()=>`${includesTransfer?'Order':'Sales Order'} links changed: ${current.salesOrderRefs.join(', ')} → ${next.salesOrderRefs.join(', ')}.`,
    'request-time-change':()=>`Requested time change: ${slot(current.confirmedWindow)} → ${slot(next.pendingWindow)}. The approved time remains active.`,
    'counter-time-change':()=>`Counter-proposed time change: ${slot(current.pendingWindow)} → ${slot(next.pendingWindow)}. The approved time remains active until Sales accepts.`,
    'accept-counter-time-change':()=>`Sales accepted Dispatch time change: ${slot(current.confirmedWindow)} → ${slot(next.confirmedWindow)}.`,
    'withdraw-counter-time-change':()=>`Dispatch withdrew counter-proposal: ${slot(current.pendingWindow)}. Approved time remains ${slot(current.confirmedWindow)}.`,
    'accept-time-change':()=>`Accepted time change: ${slot(current.confirmedWindow)} → ${slot(next.confirmedWindow)}.`,
    'decline-time-change':()=>`Declined time change: ${slot(current.pendingWindow)}. Approved time remains ${slot(current.confirmedWindow)}.`,
    'withdraw-time-change':()=>`Withdrew time change: ${slot(current.pendingWindow)}. Approved time remains ${slot(current.confirmedWindow)}.`,
    cancel:()=>current.salesOrderRefs.length?`Cancelled. Released ${includesTransfer?'orders':'Sales Orders'}: ${current.salesOrderRefs.join(', ')}.`:'Cancelled.'
  };
  return [messages[action]?.(),reply].filter(Boolean).join(' ');
}
async function rateGraph(loadType, at, lock = false) {
  const code = loadType === 'pos' ? 'DELIVERY_CHARGE_MBBS' : 'DELIVERY_CHARGE_MBT_2026_RATE';
  const result = await query(`SELECT c.rate_card_code, c.display_name, c.currency, c.revision AS card_revision,
      v.rate_card_version_id, v.version_number, v.revision AS version_revision
    FROM mbt_rate_cards c JOIN mbt_rate_card_versions v USING(rate_card_id)
    WHERE c.active AND c.rate_card_code=$1 AND v.status='active'
      AND (v.effective_from IS NULL OR v.effective_from <= $2) AND (v.effective_to IS NULL OR v.effective_to > $2)
    LIMIT 1 ${lock ? 'FOR SHARE OF c FOR UPDATE OF v' : ''}`, [code, at]);
  if (!result.rowCount) {throw failure('DELIVERY_QUOTE_UNAVAILABLE', `No active ${loadType.toUpperCase()} transport rate card is available.`, 422);}
  const row = result.rows[0];
  const bands = await query(`SELECT b.*, bt.type_code AS bin_type_code FROM mbt_rate_distance_bands b
    LEFT JOIN mbt_bin_types bt USING(bin_type_id) WHERE b.rate_card_version_id=$1
      AND (b.bin_type_id IS NULL OR bt.active) ORDER BY b.sequence_number`, [row.rate_card_version_id]);
  return { rateCardCode: row.rate_card_code, displayName: row.display_name, currency: row.currency,
    rateCardVersionId: row.rate_card_version_id, versionNumber: row.version_number,
    cardRevision: Number(row.card_revision), versionRevision: Number(row.version_revision),
    bands: bands.rows.map(band => ({ rateDistanceBandId: band.rate_distance_band_id, itemCode: band.item_code,
      serviceCode: band.service_code, binTypeCode: band.bin_type_code, minimumMetres: Number(band.minimum_metres),
      maximumMetres: band.maximum_metres === null ? null : Number(band.maximum_metres), sequenceNumber: band.sequence_number,
      amountMinor: Number(band.amount_minor), baseAmountMinor: band.base_amount_minor === null ? null : Number(band.base_amount_minor),
      includedMetres: band.included_metres === null ? null : Number(band.included_metres), currency: band.currency,
      pricingBasis: band.pricing_basis, boundaryRule: band.boundary_rule, originYardCodes: band.origin_yard_codes,
      downtownSurchargeMinor: Number(band.downtown_surcharge_minor) })) };
}
function orderRefs(order) {
  return [order.id, order.orderRef, order.dispatchRef, order.sourceOrderId, order.relatedSoId,
    ...(order.childOrders || []), ...(order.groupAliases || []),
    ...(order.childOrderDetails || []).flatMap(child => [child.id, child.originalOrderId])]
    .filter(value => typeof value === 'string').map(value => value.toUpperCase());
}
export async function prioritizeDeliveryOrders(orders) {
  if (!orders.length) {return orders;}
  const refs = [...new Set(orders.flatMap(orderRefs))];
  const result = await query(`SELECT DISTINCT ON (link.order_ref) link.order_ref,request.data->'confirmedWindow' AS window
    FROM delivery_request_sales_orders link JOIN delivery_requests request ON request.id=link.request_id
    WHERE request.status='confirmed' AND link.order_ref=ANY($1::text[])
    ORDER BY link.order_ref,request.updated_at DESC,request.id DESC`, [refs]);
  const secured = new Map(result.rows.map(row => [row.order_ref,row]));
  return orders.map(order => applyDeliveryOrderWindow(order,secured))
    .sort((left,right) => Number(right.deliveryApprovalPriority===true)-Number(left.deliveryApprovalPriority===true));
}
function applyDeliveryOrderWindow(order,secured) {
  const next={...order},fields=['expectedDeliveryDate','windowStart','windowEnd'];
  if(order.deliveryRequestOriginalWindow) {
    for(const field of fields) {
      delete next[field];
      if(Object.hasOwn(order.deliveryRequestOriginalWindow,field)) {next[field]=order.deliveryRequestOriginalWindow[field];}
    }
  }
  delete next.deliveryApprovalPriority;delete next.deliveryRequestOriginalWindow;
  const approval=orderRefs(order).map(ref=>secured.get(ref)).find(Boolean);
  if(!approval) {return next;}
  next.deliveryApprovalPriority=true;
  // Existing approved windows remain authoritative, including legacy slots shorter than two hours.
  if(approval.window?.date && approval.window.start && approval.window.end) {
    next.deliveryRequestOriginalWindow=Object.fromEntries(fields.filter(field=>Object.hasOwn(next,field)).map(field=>[field,next[field]]));
    next.expectedDeliveryDate=approval.window.date;next.windowStart=approval.window.start;next.windowEnd=approval.window.end;
  }
  return next;
}
// Only internal SQL aliases may be supplied. Used before keyset pagination.
export function deliveryPrioritySql(alias) {
  if (!/^[a-z_]+$/.test(alias)) {throw new TypeError('Invalid SQL alias.');}
  return `EXISTS (SELECT 1 FROM delivery_request_sales_orders delivery_link
    JOIN delivery_requests delivery_request ON delivery_request.id=delivery_link.request_id
    WHERE delivery_request.status='confirmed' AND delivery_link.order_ref IN (
      SELECT upper(ref) FROM jsonb_array_elements_text(jsonb_build_array(${alias}.order_ref,
        ${alias}.card->>'dispatchRef',${alias}.card->>'sourceOrderId',${alias}.card->>'relatedSoId')
        || COALESCE(${alias}.card->'childOrders','[]'::jsonb) || COALESCE(${alias}.card->'groupAliases','[]'::jsonb)) AS refs(ref)))`;
}
export function createDeliveryRequestService({ resolveDistance, emit = () => {}, now = () => new Date(),documents=createDeliveryRequestDocuments() } = {}) {
  const time = () => new Date(now()).toISOString();
  async function getSettings(lock = false) {
    const result = await query(`SELECT settings,revision FROM delivery_request_settings WHERE id=true ${lock ? 'FOR SHARE' : ''}`);
    return { ...result.rows[0].settings, revision: result.rows[0].revision };
  }
  async function setSettings(input, actor) {
    requireAudience(actor, 'dispatch');
    const settings = normalizeDeliverySettings(input);
    const result = await query(`UPDATE delivery_request_settings SET settings=$1,revision=revision+1,updated_by=$2,updated_at=$3
      WHERE id=true AND ($4::int IS NULL OR revision=$4) RETURNING settings,revision`, [settings,actor.id,time(),input.expectedRevision ?? null]);
    if (!result.rowCount) {throw failure('DELIVERY_STALE_REVISION','Delivery settings changed. Refresh before saving.',409);}
    return { ...result.rows[0].settings, revision: result.rows[0].revision };
  }
  async function detail(row) {
    const history = await query(`SELECT revision,action,actor_name,message,created_at,snapshot->>'eventAudience' AS audience FROM delivery_request_events
      WHERE request_id=$1 ORDER BY revision DESC LIMIT 200`, [row.id]);
    return { ...row, history:history.rows.map(mapEvent),conversation:await loadConversation(row) };
  }
  async function loadConversation(row) {
    const messages=[];let revision=row.revision;
    for(;;) {
      const batch=await query(`SELECT event.revision,event.action,event.actor_name,event.message,event.created_at,
      event.snapshot->>'eventAudience' AS audience,event.snapshot->>'conversationMessage' AS conversation_message,
      event.snapshot,previous.snapshot AS previous_snapshot FROM delivery_request_events event
      LEFT JOIN delivery_request_events previous ON previous.request_id=event.request_id AND previous.revision=event.revision-1
        AND NOT(event.snapshot ? 'conversationMessage')
      WHERE event.request_id=$1 AND event.revision<=$2 AND event.action NOT IN ('instructions','remind','expire')
        AND btrim(COALESCE(event.snapshot->>'conversationMessage',event.message))<>'' ORDER BY event.revision DESC LIMIT 200`,[row.id,revision]);
      messages.push(...batch.rows.map(mapConversationEvent).filter(Boolean));
      if(batch.rowCount<200 || messages.length>=200) {return messages.slice(0,200).reverse();}
      revision=batch.rows.at(-1).revision-1;
    }
  }
  function mapEvent(event) {
    const legacyDispatch=['confirm','propose','accept-time-change','decline-time-change','counter-time-change','withdraw-counter-time-change'];
    const legacySales=['submit','edit','reraise','accept','counter','secure','relink','request-time-change','withdraw-time-change','accept-counter-time-change'];
    const audience=event.audience || (legacyDispatch.includes(event.action)?'dispatch':legacySales.includes(event.action)?'sales':'staff');
    return {revision:event.revision,action:event.action,audience,actorName:event.actor_name,message:event.message,createdAt:iso(event.created_at)};
  }
  function mapConversationEvent(event) {
    const mapped=mapEvent(event);
    if(!['sales','dispatch'].includes(mapped.audience)) {return null;}
    const automatic=event.conversation_message===null && event.previous_snapshot?actionMessage(event.action,event.previous_snapshot,event.snapshot,''):'';
    const legacy=automatic && event.message.startsWith(automatic)?event.message.slice(automatic.length):event.message;
    const message=String(event.conversation_message ?? legacy).trim();
    return message?{...mapped,message}:null;
  }
  async function load(id, actor, audience, lock = false) {
    requireAudience(actor,audience);
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) {throw failure('DELIVERY_REQUEST_INVALID','Invalid delivery request number.');}
    const result = await query(`SELECT * FROM delivery_requests WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!result.rowCount) {throw failure('DELIVERY_NOT_FOUND','Delivery request not found.',404);}
    const row = mapRequest(result.rows[0]);
    assertDeliveryYard(actor,row.requestingYardLocationId,audience);
    return row;
  }
  async function record(row, action, actor, message = '',audience='system',conversationMessage='') {
    await query(`INSERT INTO delivery_request_events(request_id,revision,action,actor_id,actor_name,message,snapshot,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.id,row.revision,action,actor?.id || null,actorName(actor),message,{...row,eventAudience:audience,conversationMessage},time()]);
    if (actor?.id) {await readReceipt(row.id,row.revision,actor.id);}
    afterTransactionCommit(() => emit({ requestId:row.id, revision:row.revision, action }));
  }
  async function persist(row, action, actor, message = '',audience='system',conversationMessage='') {
    const result = await query(`UPDATE delivery_requests SET status=$2,revision=$3,data=$4,
      approval_expires_at=$5,reminder_at=$6,reminder_sent_at=$7,last_actor_id=$8,last_action=$9,updated_at=$10
      WHERE id=$1 RETURNING *`, [row.id,row.status,row.revision,row,row.approvalExpiresAt,row.reminderAt,row.reminderSentAt,actor?.id || null,action,time()]);
    const saved = mapRequest(result.rows[0]);
    await record(saved,action,actor,message,audience,conversationMessage);
    return saved;
  }
  async function expireLocked(row) {
    if (deliveryApprovalDue(row,time()) !== 'expire') {return row;}
    return persist({ ...row,status:'expired',revision:row.revision+1,approvalExpiresAt:null,reminderAt:null },'expire',null,'Approval expired. Re-raise for Dispatch approval.');
  }
  async function readReceipt(id, revision, actorId) {
    await query(`INSERT INTO delivery_request_reads(request_id,operator_id,read_revision,updated_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(request_id,operator_id) DO UPDATE SET read_revision=GREATEST(delivery_request_reads.read_revision,EXCLUDED.read_revision),updated_at=EXCLUDED.updated_at`, [id,actorId,revision,time()]);
  }
  async function operation(actor, input, kind, run) {
    if (!uuid(input.operationId)) {throw failure('DELIVERY_REQUEST_INVALID','A unique operation ID is required.');}
    return withTransaction(async () => {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`delivery-operation:${actor.id}:${input.operationId}`]);
      const fingerprint = digest({ kind,input });
      const existing = await query('SELECT fingerprint,response FROM delivery_request_operations WHERE operator_id=$1 AND operation_id=$2', [actor.id,input.operationId]);
      if (existing.rowCount) {
        if (existing.rows[0].fingerprint !== fingerprint) {throw failure('DELIVERY_OPERATION_CONFLICT','This operation ID was already used for a different action.',409);}
        const result = existing.rows[0].response;
        // Permission is checked again on replay, even if yard access changed.
        assertDeliveryYard(actor,result.requestingYardLocationId,kind.startsWith('dispatch:') ? 'dispatch' : 'sales');
        return {...result,conversation:await loadConversation(result)};
      }
      const result = await run();
      if (!result.error) {await query('INSERT INTO delivery_request_operations(operator_id,operation_id,fingerprint,response,created_at) VALUES($1,$2,$3,$4,$5)', [actor.id,input.operationId,fingerprint,result,time()]);}
      return result;
    });
  }
  async function quote(input, actor) {
    requireAudience(actor,'sales');
    assertDeliveryYard(actor,input.requestingYardLocationId,'sales');
    const pricing = await normalizePricing(input);
    assertDeliveryYard(actor,pricing.requestingYardLocationId,'sales');
    const settings = await getSettings(), graph = await rateGraph(pricing.loadType,time());
    const billingOutbounds = deliveryBillingOutbounds(pricing);
    // Validate coverage before making a paid route request.
    calculateDeliveryQuote(pricing,billingOutbounds.map(() => graph),billingOutbounds.map(() => 0),settings);
    if (typeof resolveDistance !== 'function') {throw failure('DELIVERY_QUOTE_UNAVAILABLE','Driving route pricing is unavailable.',503);}
    const routeYards=pricing.tripType==='multi_stop'?[...new Set(pricing.tripLegs.flatMap(leg=>[leg.pickupYardCode,leg.dropoffYardCode]).filter(Boolean))].map(code=>({originYardCode:code})):billingOutbounds;
    const yards=billingOutbounds.length>1 || ['round_trip','multi_stop'].includes(pricing.tripType)?await configuredConsolidationYards(routeYards):new Map();
    const routeResults = await Promise.all(deliveryJourneyRoutes(pricing).map(leg=>resolveQuoteRoute(leg,yards)));
    const routes = Object.fromEntries(routeResults);
    const calculated = calculateDeliveryJourneyQuote(pricing,graph,routes,settings);
    const id = crypto.randomUUID(), expiresAt = new Date(new Date(time()).getTime()+600000).toISOString();
    const evidence = { ...calculated,id,expiresAt,pricing,settingsRevision:settings.revision,rateFingerprint:digest(graph),
      outbounds:calculated.outbounds,routeEvidence:routes };
    await query(`INSERT INTO delivery_request_quotes(id,requesting_yard_location_id,pricing,settings_revision,quote,created_by,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id,pricing.requestingYardLocationId,pricing,settings.revision,evidence,actor.id,time(),expiresAt]);
    return evidence;
  }
  async function normalizePricing(input) {
    if(input.loadType==='bin' && input.quantityUnit==='yard') {
      const bins=await query('SELECT nominal_yards FROM mbt_bin_types WHERE active AND type_code=$1',[String(input.binTypeCode || '').trim().toUpperCase()]);
      if(!bins.rowCount) {throw failure('DELIVERY_REQUEST_INVALID','Choose an active BIN size.');}
      return normalizeDeliveryPricing({...input,binCapacityYards:Number(bins.rows[0].nominal_yards)});
    }
    return normalizeDeliveryPricing(input);
  }
  async function configuredConsolidationYards(outbounds) {
    const codes=outbounds.map(yard=>yard.originYardCode);
    const result=await query('SELECT * FROM mbt_yards WHERE active AND yard_code=ANY($1::text[])',[codes]);
    const yards=new Map(result.rows.map(yard=>[yard.yard_code,yard]));
    for(const code of codes) {
      const yard=yards.get(code);
      if(!yard) {throw failure('DELIVERY_QUOTE_UNAVAILABLE',`Yard ${code} is not active.`,422);}
      if(!yard.address_line_1) {throw failure('DELIVERY_QUOTE_UNAVAILABLE',`Yard ${code} needs a configured address.`,422);}
    }
    return yards;
  }
  async function resolveQuoteRoute(leg,yards) {
      let destinationAddressText = leg.destinationAddressText || leg.deliveryAddress, destinationSnapshot = null;
      if (leg.destinationYardCode) {
        const yard = yards.get(leg.destinationYardCode);
        destinationAddressText = [yard.address_line_1,yard.address_line_2,yard.city,yard.region,yard.postal_code,yard.country_code].filter(Boolean).join(', ');
        destinationSnapshot = {kind:'yard',yardCode:leg.destinationYardCode,revision:Number(yard.revision),addressText:destinationAddressText};
      }
      const route = await resolveDistance({originYardCode:leg.originYardCode,originAddressText:leg.originAddressText,destinationYardCode:leg.destinationYardCode,destinationAddressText});
      return [leg.key,{ ...route,...(destinationSnapshot ? {destinationSnapshot} : {}) }];
  }
  async function consumeQuote(input, actor) {
    if (!uuid(input.quoteId)) {throw failure('DELIVERY_QUOTE_REQUIRED','Calculate the delivery charge before submitting.');}
    const result = await query('SELECT * FROM delivery_request_quotes WHERE id=$1 FOR UPDATE', [input.quoteId]);
    if (!result.rowCount) {throw failure('DELIVERY_QUOTE_REQUIRED','Calculate a valid delivery quote before submitting.');}
    const ticket = result.rows[0];
    assertDeliveryYard(actor,ticket.requesting_yard_location_id,'sales');
    if (ticket.consumed_at) {throw failure('DELIVERY_QUOTE_USED','This quote has already been submitted.',409);}
    if (new Date(ticket.expires_at).getTime() <= new Date(time()).getTime()) {throw failure('DELIVERY_QUOTE_EXPIRED','The quote expired. Calculate the charge again.',409);}
    const pricing = await normalizePricing(input);
    if (digest(pricing) !== digest(ticket.pricing)) {throw failure('DELIVERY_QUOTE_CHANGED','Delivery details changed. Calculate the charge again.',409);}
    const settings = await getSettings(true), graph = await rateGraph(pricing.loadType,time(),true);
    if (settings.revision !== ticket.settings_revision || digest(graph) !== ticket.quote.rateFingerprint) {
      throw failure('DELIVERY_QUOTE_CHANGED','The rate card or capacity changed. Calculate the charge again.',409);
    }
    await assertQuoteYards(ticket.quote);
    await query('UPDATE delivery_request_quotes SET consumed_at=$2 WHERE id=$1', [ticket.id,time()]);
    // Protect the rate version used as evidence with the existing first-use rule.
    await query(`UPDATE mbt_rate_card_versions SET first_used_at=COALESCE(first_used_at,$2),
      first_used_entity_type=COALESCE(first_used_entity_type,'delivery_request_quote'),first_used_entity_id=COALESCE(first_used_entity_id,$3::uuid)
      WHERE rate_card_version_id=$1 AND first_used_at IS NULL`, [graph.rateCardVersionId,time(),ticket.id]);
    return { pricing,quote:ticket.quote };
  }
  async function assertQuoteYards(quoteEvidence) {
    for (const route of Object.values(quoteEvidence.routeEvidence)) {
      for (const snapshot of [route.originSnapshot,route.destinationSnapshot]) {
        if (snapshot?.revision !== undefined) {
          const current = await query('SELECT revision FROM mbt_yards WHERE yard_code=$1 AND active FOR SHARE', [snapshot.yardCode]);
          if (!current.rowCount || Number(current.rows[0].revision) !== snapshot.revision) {throw failure('DELIVERY_QUOTE_CHANGED','A route yard changed. Calculate the charge again.',409);}
        }
      }
    }
  }
  async function create(input, actor) {
    requireAudience(actor,'sales');
    return operation(actor,input,'sales:create',async () => {
      const { pricing,quote:ticket } = await consumeQuote(input,actor);
      const estimate=await documents.validateEstimate(input.estimateRef,pricing.requestingYardLocationId);
      const data = { ...pricing,quote:ticket,requestedWindow:normalizeDeliveryWindow(input.requestedWindow),
        customerName:text(input.customerName,250,'Customer'),remarks:text(input.remarks,5000,'Remarks'),
        estimateRef:estimate?.reference || '',estimateId:estimate?.id || null,
        proposedWindow:null,confirmedWindow:null,salesOrderRefs:[],securedAt:null };
      const result = await query(`INSERT INTO delivery_requests(requesting_yard_location_id,status,data,created_by,last_actor_id,last_action,created_at,updated_at)
        VALUES($1,'submitted',$2,$3,$3,'submit',$4,$4) RETURNING *`, [pricing.requestingYardLocationId,data,actor.id,time()]);
      const row = mapRequest(result.rows[0]);
      await record(row,'submit',actor,'','sales');
      return detail(row);
    });
  }
  async function act(id, action, input, actor, audience) {
    requireAudience(actor,audience);
    const result = await operation(actor,input,`${audience}:${id}:${action}`,async () => {
      const original = await load(id,actor,audience,true), current = action==='reply'?original:await expireLocked(original);
      if (current.status === 'expired' && original.status !== 'expired' && !['reraise','cancel'].includes(action)) {
        return { error:failure('DELIVERY_APPROVAL_EXPIRED','This approval expired. Re-raise it for Dispatch approval.',409) };
      }
      let next = transitionDeliveryRequest(current,action,input,actor,audience,{ now:time(),settings:await getSettings(true) });
      if (['secure','relink'].includes(action)) {
        const refs = next.salesOrderRefs;
        for (const ref of refs) {
          if(ref.startsWith('TO')) {await getDeliveryRequestTransferOrder(ref,current.requestingYardLocationId);}
          else {await getDeliveryInstruction(ref,{authorizedOrderingLocationIds:[current.requestingYardLocationId]});}
        }
        // Recheck the deadline after all order lookups, while still holding the row lock.
        next = transitionDeliveryRequest(current,action,input,actor,audience,{now:time()});
        await query('DELETE FROM delivery_request_sales_orders WHERE request_id=$1',[id]);
        for (const ref of refs) {await query('INSERT INTO delivery_request_sales_orders(request_id,order_ref) VALUES($1,$2)',[id,ref]);}
      }
      if (action==='cancel') {await query('DELETE FROM delivery_request_sales_orders WHERE request_id=$1',[id]);}
      if (['edit','reraise'].includes(action)) {next=await editRequest(current,next,input,actor);}
      const reply=text(input.message,2000,'Reply'),message=actionMessage(action,current,next,reply);
      return detail(await persist(next,action,actor,message,audience,reply));
    });
    if (result.error) {throw result.error;}
    return result;
  }
  async function editRequest(current,next,input,actor) {
    const quoted=await consumeQuote(input,actor);
    if(quoted.pricing.requestingYardLocationId!==current.requestingYardLocationId) {throw failure('DELIVERY_REQUEST_INVALID','The requesting yard cannot change.');}
    const updated={...next,...quoted.pricing,quote:quoted.quote,requestedWindow:normalizeDeliveryWindow(input.requestedWindow),
      customerName:text(input.customerName,250,'Customer'),remarks:text(input.remarks,5000,'Remarks')};
    for(const field of ['quantityUnit','aggregate','binCapacityYards','tripType','tripLegs']) {if(!Object.hasOwn(quoted.pricing,field)) {delete updated[field];}}
    if(input.estimateRef!==undefined) {
      const estimate=await documents.validateEstimate(input.estimateRef,current.requestingYardLocationId);
      updated.estimateRef=estimate?.reference || '';updated.estimateId=estimate?.id || null;
    }
    return updated;
  }
  async function tick() {
    return withTransaction(async () => {
      const at = time();
      const due = await query(`SELECT * FROM delivery_requests WHERE status IN ('preapproved','proposed')
        AND (approval_expires_at <= $1 OR (reminder_at <= $1 AND reminder_sent_at IS NULL))
        ORDER BY approval_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`, [at]);
      for (const source of due.rows) {
        const row = mapRequest(source), action = deliveryApprovalDue(row,at);
        if (action === 'expire') {await expireLocked(row);}
        else if (action === 'remind') {await persist({ ...row,revision:row.revision+1,reminderSentAt:at },'remind',null,'Add at least one Sales or Transfer Order before the approval expires.');}
      }
      await query('DELETE FROM delivery_request_quotes WHERE consumed_at IS NULL AND expires_at < $1::timestamptz - interval \'1 day\'', [at]);
      return due.rowCount;
    });
  }
  async function get(id,actor,audience) {
    return withTransaction(async () => detail(await expireLocked(await load(id,actor,audience,true))));
  }
  async function list(actor,audience,filters = {}) {
    const yards = requireAudience(actor,audience);
    await tick();
    const search = text(filters.search,120,'Search');
    const statuses = [...new Set((Array.isArray(filters.status)?filters.status:[filters.status]).map(status=>text(status,30,'Status')).filter(Boolean))];
    const result = await query(`SELECT * FROM delivery_requests WHERE requesting_yard_location_id=ANY($1::int[])
      AND (cardinality($2::text[])=0 OR status=ANY($2::text[])) AND ($3='' OR ('DR-'||lpad(id::text,6,'0')||' '||data::text) ILIKE '%'||$3||'%')
      ORDER BY updated_at DESC,id DESC LIMIT 200`, [yards,statuses,search]);
    return { requests:result.rows.map(mapRequest) };
  }
  async function alerts(actor,audience) {
    const yards = requireAudience(actor,audience);
    const result = await query(`SELECT request.*,count(*) OVER() AS unread_count FROM delivery_requests request
      LEFT JOIN delivery_request_reads receipt ON receipt.request_id=request.id AND receipt.operator_id=$2
      WHERE request.requesting_yard_location_id=ANY($1::int[]) AND request.revision>COALESCE(receipt.read_revision,0)
      ORDER BY request.updated_at DESC,request.id DESC LIMIT 201`, [yards,actor.id]);
    return { count:Number(result.rows[0]?.unread_count || 0),requests:result.rows.slice(0,200).map(row => {
      const item = mapRequest(row);
      return { id:item.id,requestRef:item.requestRef,revision:item.revision,status:item.status,action:item.lastAction,updatedAt:item.updatedAt,approvalExpiresAt:item.approvalExpiresAt };
    }) };
  }
  async function markRead(id, revision, actor, audience) {
    const row = await load(id,actor,audience);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > row.revision) {throw failure('DELIVERY_REQUEST_INVALID','Read revision must refer to a displayed update.');}
    await readReceipt(row.id,revision,actor.id);
    return { id:row.id,readRevision:revision };
  }
  async function instructionChanged(ref,actorId) {
    return withTransaction(async () => {
      const result = await query(`SELECT request.* FROM delivery_requests request
        WHERE request.status='confirmed' AND EXISTS (
          SELECT 1 FROM delivery_request_sales_orders link
          LEFT JOIN sales_orders linked_order ON upper(btrim(linked_order.tranid))=link.order_ref
          LEFT JOIN dispatch_scm_so_splits split ON split.split_so_id=linked_order.netsuite_id
          LEFT JOIN sales_orders source_order ON source_order.netsuite_id=split.source_so_id
          WHERE link.request_id=request.id AND (link.order_ref=upper($1) OR upper(btrim(source_order.tranid))=upper($1)))
        ORDER BY request.id FOR UPDATE OF request`, [ref]);
      for (const row of result.rows) {
        const current = mapRequest(row);
        await persist({ ...current,revision:current.revision+1 },'instructions',actorId ? {id:actorId} : null,`Delivery instructions updated for ${ref}.`);
      }
    });
  }
  async function options(actor,audience) {
    const yards = requireAudience(actor,audience);
    const bins = await query(`SELECT DISTINCT bt.type_code,bt.display_name,bt.nominal_yards FROM mbt_bin_types bt
      JOIN mbt_rate_distance_bands b USING(bin_type_id) JOIN mbt_rate_card_versions v USING(rate_card_version_id)
      JOIN mbt_rate_cards c USING(rate_card_id) WHERE bt.active AND c.active AND v.status='active'
      AND c.rate_card_code='DELIVERY_CHARGE_MBT_2026_RATE' ORDER BY bt.type_code`);
    return { requestingYards:yards.map(id => ({id,code:DELIVERY_YARDS[id]})),outboundYards:Object.values(DELIVERY_YARDS),
      binTypes:bins.rows.map(bin => ({code:bin.type_code,name:bin.display_name,nominalYards:Number(bin.nominal_yards)})),aggregates:DELIVERY_AGGREGATES,settings:await getSettings() };
  }
  async function previewEstimate(reference,yard,actor,audience) {
    requireAudience(actor,audience);assertDeliveryYard(actor,Number(yard),audience);
    return documents.estimate(reference,Number(yard));
  }
  async function previewAttachedEstimate(id,actor,audience) {
    const row=await load(id,actor,audience);
    return documents.estimate(row.estimateRef,row.requestingYardLocationId);
  }
  async function previewLinkedOrder(id,reference,actor,audience,kind) {
    const row=await load(id,actor,audience),ref=String(reference || '').trim().toUpperCase();
    if(!ref.startsWith(kind==='transferOrder'?'TO':'SO') || !row.salesOrderRefs.includes(ref)) {throw failure('DELIVERY_ACCESS_DENIED','This order is not linked to the request.',403);}
    const document=await documents[kind](ref,row.requestingYardLocationId);
    // Recheck access and linkage after the remote read; unlinking must not leak a stale preview.
    const current=await load(id,actor,audience);
    if(!current.salesOrderRefs.includes(ref)) {throw failure('DELIVERY_ACCESS_DENIED','This order is no longer linked to the request.',403);}
    return document;
  }
  return { getSettings,setSettings,options,quote,create,act,get,list,tick,alerts,markRead,instructionChanged,
    previewEstimate,previewAttachedEstimate,
    previewSalesOrder:(...args)=>previewLinkedOrder(...args,'salesOrder'),
    previewTransferOrder:(...args)=>previewLinkedOrder(...args,'transferOrder') };
}
