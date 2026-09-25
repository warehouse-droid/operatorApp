// Deliberately alter the implementation text read by the existing VM harness.
// The original assertions and network boundary remain intact.
import fs from 'node:fs';
const read = fs.readFileSync;
fs.readFileSync = function (file, ...options) {
  const value = read.call(this, file, ...options);
  if (String(file).endsWith('/src/netsuite.js')) {
    const source = String(value), anchor = 'if (expectedVersion) {';
    if (source.split(anchor).length !== 2) { throw new Error('PO version mutation anchor must be unique.'); }
    process.stderr.write('NETSUITE_PRIORITY_MUTATION:po_version_recheck\n');
    const modified = source.replace(anchor, 'if (false) {');
    return typeof value === 'string' ? modified : Buffer.from(modified);
  }
  return value;
};
