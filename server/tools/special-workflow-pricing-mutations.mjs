import { cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
if (process.env.MBT_TEST_ISOLATED !== '1' || !process.env.DATABASE_URL?.endsWith('/mbt_verify')) throw new Error('Use the isolated verification database');
const root = '/tmp/special-workflow-pricing-mutants';
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
for (const dir of ['src','public','test','migrations']) await cp(dir, path.join(root, dir), { recursive: true });
await cp('package.json', path.join(root, 'package.json'));
await symlink('/app/node_modules', path.join(root, 'node_modules'));
const tests=['test/mbt/unit/special-workflow-pricing.test.js','test/mbt/unit/special-workflow-quantity-adapter.test.js','test/mbt/unit/special-workflow-quantity-service.test.js','test/mbt/integration/special-workflow-pricing.test.js','test/mbt/integration/special-workflow-pricing-http.test.js'];
const properties=['--test-name-pattern=property:',tests[0],tests[1]];
const mutants=[
 ['original rate mutable','src/special-stock-pricing-domain.js','if (Number(line.rate) !== originalRate)','if (false)'],
 ['line discount ignored','public/special-stock-pricing.js','const cents = (units * price * (1_000_000n - percent) + denominator / 2n) / denominator;','const cents = (units * price * 1_000_000n + denominator / 2n) / denominator;'],
 ['two working days','public/special-stock-pricing.js','added < 3','added < 2'],
 ['PO quantity not updated','src/special-stock-quantity-adapter.js','for (const order of plan.orders) {','for (const order of plan.orders.slice(0,1)) {'],
 ['review bypassed','src/special-stock-pricing-domain.js','if (quantityReviewPending(special.quantity_review || special.quantityReview))','if (false)']
];
let killed = 0, propertyKilled = 0;
function execute(args, cwd = root, env = process.env) {
  return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
}
const baseline = execute(['--test','--test-concurrency=1',...tests]);
if (baseline.status !== 0) throw new Error(`Mutation baseline failed: ${baseline.stdout}${baseline.stderr}`);
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
console.log(`Pricing manual mutation: ${killed}/${mutants.length} killed; property-only: ${propertyKilled}/${mutants.length} killed.`);
