import assert from 'node:assert/strict';

export function priorSource(source) {
  return source.replace(/(?:\/\*\* @param \{string\} valueExpression \*\/\n)?function customOrderYardLocationIdSql\(valueExpression\) \{[\s\S]*?(?=function receivedSalesSql)/u, '')
    .replace('${customOrderYardLocationIdSql("o.pickup_location")}', '${exactYardCodeLocationIdSql("o.pickup_location")}');
}

export const mutants = {
  wrongCode: ["= '3445' THEN 1::bigint", "= '3445' THEN 28::bigint", 'Y3:'],
  wrongAddressYard: ['THEN MIN(yard.dispatch_location_id)::bigint', 'THEN 28::bigint', 'Y2:'],
  ambiguousAddress: ['COUNT(DISTINCT yard.dispatch_location_id) = 1', 'COUNT(DISTINCT yard.dispatch_location_id) >= 1', 'Y7:'],
  offsiteNumber: ['${customOrderYardLocationIdSql("o.pickup_location")}', '${yardLocationIdSql("o.pickup_location")}', 'Y4:'],
  caseSensitive: ['LOWER(BTRIM(REGEXP_REPLACE(COALESCE(${expression}, \'\'), \'[[:space:]]+\', \' \', \'g\')))',
    'BTRIM(REGEXP_REPLACE(COALESCE(${expression}, \'\'), \'[[:space:]]+\', \' \', \'g\'))', 'Y2:']
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.CUSTOM_YARD_MUTANT;
  if (!name || !url.endsWith('/src/yard-movement-repository.js')) return result;
  const source = String(result.source);
  process.stderr.write(`CUSTOM_YARD_MUTATION:${name}\n`);
  if (name === 'prior') return {...result, source: priorSource(source)};
  const [from, to] = mutants[name];
  assert.equal(source.split(from).length, 2, `Unique mutation anchor: ${name}`);
  return {...result, source:source.replace(from, to)};
}
