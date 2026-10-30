import { register } from 'node:module';
register(`data:text/javascript,${encodeURIComponent(`
import { readFileSync } from 'node:fs';
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/operator-load-quantity.js')) {
    return { format: 'module', source: readFileSync(process.env.LOAD_ROUNDING_MUTANT, 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}`)}`, import.meta.url);
