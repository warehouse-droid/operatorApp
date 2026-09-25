import { spawnSync } from 'node:child_process';

if (process.env.MBT_TEST_ISOLATED !== '1' || !process.env.DATABASE_URL?.endsWith('/mbt_verify')) throw new Error('Use the isolated verification database');
let total = 0;
for (const file of process.argv.slice(2)) {
  // Node 20 sorts multiple test filenames internally. Separate invocations make
  // the requested shuffled file order observable and preserve shared DB checks.
  console.log(`FILE ${file}`);
  const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) throw new Error(`Shuffled suite failed: ${file}`);
  const count = /^# tests (\d+)$/m.exec(result.stdout);
  if (!count) throw new Error(`Missing test count: ${file}`);
  total += Number(count[1]);
}
console.log(`Shuffled suite: ${total} tests passed, 0 failures.`);
