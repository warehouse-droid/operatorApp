import { cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
if (process.env.MBT_TEST_ISOLATED !== '1' || !process.env.DATABASE_URL?.endsWith('/mbt_verify')) throw new Error('Use the isolated verification database');
const root = '/tmp/special-workflow-polish-mutants';
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
for (const dir of ['src','public','test']) await cp(dir, path.join(root, dir), { recursive: true });
await cp('package.json', path.join(root, 'package.json'));
await symlink('/app/node_modules', path.join(root, 'node_modules'));
const tests = ['test/mbt/unit/special-workflow-polish.test.js','test/mbt/integration/special-workflow-polish.test.js','test/mbt/integration/special-workflow-polish-http.test.js'];
const properties = ['--test-name-pattern=property:', tests[0]];
const mutants = [
  ['gate ignored', 'src/special-stock-request-repository.js', 'if (gates.rowCount !== 2 || gates.rows.some(row => row.enabled !== true))', 'if (false)'],
  ['remote actions allowed for tests', 'src/special-stock-request-policy.js', 'if (detail?.salesOrderSkipped || detail?.purchaseOrderSkipped)', 'if (false)'],
  ['PO skip does not advance stage', 'public/special-stock-workflow.js', 'evidence.purchaseOrderId || evidence.purchaseOrderSkipped', 'evidence.purchaseOrderId'],
  ['duplicate skip audits twice', 'src/special-stock-request-repository.js', 'if (special[`${field}_skipped`]) return;', ''],
  ['PO skip overwrites sales quantity', 'src/special-stock-request-repository.js', 'so SET description=po.description, updated_at=now()', 'so SET description=po.description, quantity=po.quantity, updated_at=now()'],
  ['gate lock omitted', 'src/special-stock-request-repository.js', 'ORDER BY flag_key FOR SHARE', 'ORDER BY flag_key']
];
let killed = 0, propertyKilled = 0;
function execute(args, cwd = root, env = process.env) {
  return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
}
for (const [name, file, from, to] of mutants) {
  const target = path.join(root, file), source = await readFile(target, 'utf8');
  if (source.split(from).length !== 2) throw new Error(`Mutation target not unique: ${name}`);
  try {
    await writeFile(target, source.replace(from, to));
    const result = execute(['--test','--test-concurrency=1',...tests]);
    if (result.status !== 1 || !result.stdout.includes('not ok') || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(result.stdout + result.stderr)) throw new Error(`Invalid/surviving mutant ${name}: ${result.stdout}${result.stderr}`);
    killed++; console.log(`KILLED: ${name}`);
    const property = execute(['--test', ...properties]);
    if (![0,1].includes(property.status)) throw new Error(`Invalid property mutation: ${name}`);
    propertyKilled += property.status === 1 ? 1 : 0;
    console.log(`PROPERTY-ONLY ${property.status === 1 ? 'KILLED' : 'SURVIVED'}: ${name}`);
  } finally { await writeFile(target, source); }
}
const restored = execute(['--test','--test-concurrency=1',...tests]);
if (restored.status !== 0) throw new Error(`Restored source tests failed: ${restored.stdout}${restored.stderr}`);
const browserMutants = [
  ['form edits lost', 'public/special-stock-form-state.js', 'const fields = key && drafts.get(key);', 'const fields = null;', 'scm-error-retains-all-lines'],
  ['panel scroll reset', 'public/special-stock-form-state.js', 'top: root.querySelector(selector)?.scrollTop || 0', 'top: 0', 'save-scroll-desktop'],
  ['skip button visible with gate off', 'public/sales-special-stock-requests.js', "state.testSkipOrdersEnabled && !['creating','attention'].includes(detail.salesOrderOperationStatus)", "true && !['creating','attention'].includes(detail.salesOrderOperationStatus)", 'gate-off-hides-buttons']
];
for (const [name, file, from, to, filter] of browserMutants) {
  const result = execute(['tools/special-workflow-polish-browser.mjs'], process.cwd(), { ...process.env,
    SPECIAL_POLISH_BROWSER_MUTATION: JSON.stringify([file, from, to]), SPECIAL_POLISH_BROWSER_FILTER: filter,
    SPECIAL_POLISH_BROWSER_OUTPUT: `test-artifacts/special-workflow-polish/mutant-browser/${filter}` });
  if (result.status !== 1 || !result.stdout.includes(`FAIL ${filter}:`) || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(result.stdout + result.stderr)) throw new Error(`Invalid/surviving browser mutant ${name}: ${result.stdout}${result.stderr}`);
  killed++; console.log(`KILLED (browser): ${name}`);
  console.log(`PROPERTY-ONLY NOT APPLICABLE: ${name} (DOM behavior)`);
}
console.log(`Polish manual mutation: ${killed}/${mutants.length + browserMutants.length} killed; original workspace was not mutated.`);
console.log(`Property-only backend mutation: ${propertyKilled}/${mutants.length} killed. Browser mutants are outside the stage property.`);
