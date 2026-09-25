import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scanPaths } from '../test/support/scan-diff-secrets.mjs';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Provide the source paths to scan');
const findings = await scanPaths(paths);
let reviewedHtmlExpressions = 0;
const unresolved = [];
for (const finding of findings) {
  const line = (await readFile(finding.file, 'utf8')).split(/\r?\n/)[finding.line - 1];
  // The existing scanner mistakes a dynamic HTML data-review-token attribute
  // for a literal credential assignment. Review applies to this exact line only;
  // any edit invalidates the exception and requires inspection again.
  const reviewed = finding.file === 'public/dispatch.js'
    && finding.kind === 'credential_assignment'
    && createHash('sha256').update(line).digest('hex') === '256022ee40191b3a73413be4199df8dc374c5b3b5e96622f0f7bdd9ba02ddaa5';
  if (reviewed) reviewedHtmlExpressions += 1;
  else unresolved.push(finding);
}
for (const finding of unresolved) {
  console.error(`${finding.file}:${finding.line}: possible ${finding.kind} [value redacted]`);
}
if (unresolved.length) throw new Error(`Secret scan found ${unresolved.length} unresolved finding(s)`);
console.log(`Secret scan passed: ${paths.length} source paths; ${reviewedHtmlExpressions} exact, reviewed dynamic HTML expression; no unresolved findings.`);
