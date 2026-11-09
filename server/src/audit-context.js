import { AsyncLocalStorage } from "node:async_hooks";

const auditStorage = new AsyncLocalStorage();

export function runWithAuditContext(context, fn) {
  return auditStorage.run(context, fn);
}

export function trackSemanticAudit(operation) {
  const context = auditStorage.getStore();
  if (!context) return operation;
  const tracked = Promise.resolve(operation).then((result) => {
    context.semanticAuditCount = Number(context.semanticAuditCount || 0) + 1;
    return result;
  });
  if (!Array.isArray(context.semanticAuditPromises)) context.semanticAuditPromises = [];
  context.semanticAuditPromises.push(tracked);
  return tracked;
}

// The HTTP request currently executing (request id and the Express request), set by the
// system audit middleware so audit writers can link their rows to that request.
const auditRequestStorage = new AsyncLocalStorage();

export function runWithAuditRequest(context, fn) {
  return auditRequestStorage.run(context, fn);
}

export function currentAuditRequest() {
  return auditRequestStorage.getStore() || null;
}

/** Adds the current HTTP request id (auditRequestId) to audit details so every row written
 * while handling one request can be listed together in the Admin audit log. */
export function withAuditRequestId(details) {
  const requestId = auditRequestStorage.getStore()?.requestId;
  if (!requestId || !details || typeof details !== "object" || Array.isArray(details) || details.auditRequestId) {
    return details;
  }
  return { ...details, auditRequestId: requestId };
}
