import assert from "node:assert/strict";

export const mutants = {
  visit: ["public/operator-delivery-refresh.js", "ticket.visit === visit && ", ""],
  revision: ["public/operator-delivery-refresh.js", "ticket.revision === revision", "true"],
  sequence: ["public/operator-delivery-refresh.js", "ticket.sequence === sequences.get(ticket.channel)", "true"],
  reference: ["src/operator-linked-quantity-domain.js", "salesOnly ? operatorRequired.sales <= EPSILON : projection.noYardLoadRequired", "projection.noYardLoadRequired"],
  residual: ["src/operator-linked-quantity-domain.js", "salesOnly ? operatorRequired.sales <= EPSILON : projection.noYardLoadRequired", "salesOnly ? true : projection.noYardLoadRequired"]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutants[process.env.DISPLAY_FIX_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation[0]}`)) { return result; }
  const source = String(result.source);
  assert.equal(source.split(mutation[1]).length, 2, "Mutation must match once");
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
}
