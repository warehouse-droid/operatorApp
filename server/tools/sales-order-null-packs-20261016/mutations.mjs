import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync('/tmp/so-null-mutants-');
const out = '/app/test-artifacts/sales-order-null-packs-20261016';
const normalizer = 'public/order-pack-quantities.js';
const mutations = [
  ['blank-to-zero', normalizer, "if (value == null || (typeof value === 'string' && value.trim() === '')) return null;", "if (value == null || (typeof value === 'string' && value.trim() === '')) return 0;", true],
  ['zero-to-zero', normalizer, 'return Number(value) === 0 ? null : Number(value);', 'return Number(value) === 0 ? 0 : Number(value);', true],
  ['truncate-positive', normalizer, 'return Number(value) === 0 ? null : Number(value);', 'return Number(value) === 0 ? null : Math.trunc(Number(value));', true],
  ['direct-post-bypass', 'src/netsuite.js', 'const body = normalizeSalesOrderPackPayload(payload);', 'const body = payload;', false],
  ['discount-post-bypass', 'src/netsuite.js', "const body = normalizeSalesOrderPackPayload(payload);\n  return mutate(()=>rest(path,{method:'POST',body}));", "const body = payload;\n  return mutate(()=>rest(path,{method:'POST',body}));", false],
  ['po-pack-leak', 'src/special-stock-request-netsuite.js', 'if (!purchase) {', 'if (true) {', false],
  ['request-zero-default', 'src/special-stock-request-domain.js', '...normalizePackQuantities(line),', "...Object.fromEntries(Object.entries(normalizePackQuantities(line)).map(([field,value])=>[field,value ?? 0])),", false]
];
const results = [];
try {
  for (const dir of ['src', 'public', 'test']) cpSync(dir, join(root, dir), { recursive: true });
  for (const file of ['package.json', 'netsuite-field-sales-restlet.js', 'netsuite-smart-scm-picking-ticket-restlet.js']) copyFileSync(file, join(root, file));
  symlinkSync('/app/node_modules', join(root, 'node_modules'));
  for (const [name, file, needle, replacement, property] of mutations) {
    const path = join(root, file), original = readFileSync(path, 'utf8');
    if (!original.includes(needle)) throw Error('Mutation target missing: ' + name);
    try {
      writeFileSync(path, original.replace(needle, replacement));
      const args = ['--test', 'test/mbt/unit/sales-order-null-packs.test.js'];
      const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
      writeFileSync(`${out}/mutant-${name}.log`, run.stdout + run.stderr);
      if (run.status === 0 || !run.stdout.includes('ERR_ASSERTION')) throw Error('Mutant survived or failed outside assertions: ' + name);
      let propertyKilled = null;
      if (property) {
        const onlyProperty = spawnSync(process.execPath, ['--test', '--test-name-pattern', '^property:', 'test/mbt/unit/sales-order-null-packs.test.js'], { cwd: root, encoding: 'utf8' });
        writeFileSync(`${out}/mutant-property-${name}.log`, onlyProperty.stdout + onlyProperty.stderr);
        propertyKilled = onlyProperty.status !== 0 && onlyProperty.stdout.includes('Property failed');
        if (!propertyKilled) throw Error('Property failed to detect mutant: ' + name);
      }
      results.push({ name, killed: true, propertyKilled });
    } finally { writeFileSync(path, original); }
  }
  writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(`${results.length}/${mutations.length} mutants killed; ${results.filter(r => r.propertyKilled).length}/3 property-only mutants killed`);
} finally { rmSync(root, { recursive: true, force: true }); }
