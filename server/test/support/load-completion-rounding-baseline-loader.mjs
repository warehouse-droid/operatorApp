import { register } from 'node:module';
register(`data:text/javascript,${encodeURIComponent(`
import { readFileSync } from 'node:fs';
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/delivery-repository.js')) {
    return { format: 'module', source: readFileSync('/app/test-artifacts/baseline-delivery-repository.js', 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}`)}`, import.meta.url);
