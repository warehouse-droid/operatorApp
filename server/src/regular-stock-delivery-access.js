// @ts-check
import {assertStockRequestDestinationAccess} from './stock-request-domain.js';

/** @param {unknown} value */
function pairedYard(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value).trim())) return null;
  const id = Number(value);
  return id === 1 || id === 28 ? id : null;
}

/** @param {unknown} source @param {unknown} destination */
function pairedRoute(source, destination) {
  const from = pairedYard(source), to = pairedYard(destination);
  return from !== null && to !== null && from !== to;
}

/** @param {(number|string)[]} authorized */
function has150Access(authorized) {
  return authorized.some(id => (typeof id === 'number' || typeof id === 'string')
    && /^\d+$/.test(String(id).trim()) && Number(id) === 26);
}

/** @param {unknown} source @param {unknown} destination @param {(number|string)[]} authorized
 * @param {{preview?:boolean}} options */
export function assertDeliveryStockRequestDestinationAccess(source, destination, authorized = [], {preview = false} = {}) {
  const base = pairedYard(destination);
  const discoveringBase = preview && base !== null
    && (source === undefined || source === '' || pairedYard(source) === base);
  if (pairedRoute(source, destination) || discoveringBase) return Number(destination);
  const validAuthorized = authorized.filter(id => (typeof id === 'number' || typeof id === 'string')
    && /^\d+$/.test(String(id).trim()));
  return assertStockRequestDestinationAccess(destination, validAuthorized);
}

/** @param {{requestType?:string,workflowVersion?:number,destinationLocationId?:unknown,
 * regular?:{deliveryMethod?:string,deliveryVersion?:number,sourceLocationId?:unknown}}} request
 * @param {(number|string)[]} authorized */
export function can150SalesAccessDeliveryRequest(request, authorized = []) {
  return has150Access(authorized) && request.requestType === 'regular' && request.workflowVersion === 2
    && request.regular?.deliveryMethod === 'delivery' && request.regular.deliveryVersion === 1
    && pairedRoute(request.regular.sourceLocationId, request.destinationLocationId);
}

/** @param {Parameters<typeof can150SalesAccessDeliveryRequest>[0]} request */
export function canSalesAccessDeliveryRequest(request) {
  return request.requestType === 'regular' && request.workflowVersion === 2
    && request.regular?.deliveryMethod === 'delivery' && request.regular.deliveryVersion === 1
    && pairedRoute(request.regular.sourceLocationId, request.destinationLocationId);
}

/** @param {string} authorizedParameter SQL parameter supplied only by the repository. */
export function stockRequestSalesScopeSql(authorizedParameter) {
  return `(request.destination_location_id = ANY(${authorizedParameter}::bigint[]) OR (request.request_type='regular' AND request.workflow_version=2
    AND request.regular_details->>'deliveryMethod'='delivery' AND request.regular_details->>'deliveryVersion'='1'
    AND ((request.destination_location_id=1 AND request.regular_details->>'sourceLocationId'='28')
      OR (request.destination_location_id=28 AND request.regular_details->>'sourceLocationId'='1'))
  ) OR (request.request_type='regular' AND request.workflow_version=2
    AND request.regular_details->>'deliveryMethod'='stocking'
    AND request.regular_details->>'requestingLocationId'=ANY(${authorizedParameter}::bigint[]::text[]))
    OR (request.request_type='regular' AND request.workflow_version=2 AND request.regular_details->>'deliveryMethod'='waitlist'
      AND EXISTS(SELECT 1 FROM sales_stock_requests origin JOIN sales_stock_request_events moved ON moved.request_id=origin.id
        WHERE origin.id::text=request.regular_details#>>'{stockingSource,requestId}'
          AND origin.request_type='regular' AND origin.workflow_version=2 AND origin.regular_details->>'deliveryMethod'='stocking'
          AND origin.requested_by=request.requested_by AND origin.destination_location_id=request.destination_location_id
          AND moved.event_type='stocking_line_waitlisted' AND moved.details->>'waitlistRequestId'=request.id::text
          AND moved.details->>'lineId'=request.regular_details#>>'{stockingSource,lineId}'
          AND COALESCE(origin.regular_details->>'requestingLocationId',origin.destination_location_id::text)=ANY(${authorizedParameter}::bigint[]::text[]))))`;
}
