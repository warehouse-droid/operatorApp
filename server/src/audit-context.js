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
