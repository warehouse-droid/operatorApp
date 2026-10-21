import { existing as quoteExisting, own as quoteOwn } from './special-quote-pallet-suites.mjs';
export const existing = [...new Set([...quoteExisting, ...quoteOwn])];
export const own = ['test/mbt/unit/special-case-edits.test.js', 'test/mbt/integration/special-case-edits-http.test.js',
  'test/mbt/integration/special-case-edits-browser.test.js'];
